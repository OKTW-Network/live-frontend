import {
  PLAYER_GESTURE_CONFIG,
  createPlaybackToggleCoordinator,
  createPlayerGestureRecognizer,
  isPlayerGestureBlockedTarget,
} from '../player-gestures.js';
import { createPlayerController, INITIAL_PLAYER_SNAPSHOT, PLAYER_RATES } from '../player/controller.js';

export function createPlayerComponent(Alpine) {
  return {
    playerShellObserver: null,
    playerShellHeight: 0,
    player: null,
    playerSnapshot: INITIAL_PLAYER_SNAPSHOT,
    playerRates: PLAYER_RATES,
    playerGestures: null,
    playerControlsVisible: true,
    playerGestureFeedback: null,
    playerGestureFeedbackTimer: null,
    playerPlaybackCoordinator: null,
    playerHelpOpen: false,
    settingsOpen: false,
    shareOpen: false,
    shareIncludeTime: true,
    debugOpen: false,
    debugEntries: [],
    debugCount: 0,
    debugFilters: { source: '', level: '', text: '' },
    debugAutoScroll: true,
    debugCopyStatus: '',
    posterExt: 'jxl',
    posterFailed: false,

    initPlayer() {
      this.player = createPlayerController({
        video: this.$refs.video,
        container: this.$refs.playerContainer,
        getHls: () => window.Hls,
        storage: localStorage,
        onSnapshot: (snapshot) => { this.playerSnapshot = snapshot; },
        onDebug: ({ count }) => {
          this.debugCount = count;
          if (this.debugOpen) this.refreshDebug();
        },
      });
      this.playerPlaybackCoordinator = createPlaybackToggleCoordinator({
        getPlayer: () => this.player,
        getSnapshot: () => this.playerSnapshot,
        getMediaKey: () => this.activeMediaKey,
        onFeedback: (action) => this.showPlayerGestureFeedback({
          type: 'playback',
          action,
          label: action === 'play' ? '開始播放' : '已暫停',
        }),
      });
      this.playerGestures = createPlayerGestureRecognizer({
        onMouseSingle: () => {
          if (!this.activeMediaKey) return;
          this.playerControlsVisible = true;
          this.togglePlayback({ showFeedback: true });
        },
        onMouseDouble: () => {
          if (!this.activeMediaKey) return;
          this.playerControlsVisible = true;
          this.player?.toggleFullscreen();
        },
        onTouchSingle: () => {
          if (!this.activeMediaKey) return;
          this.playerControlsVisible = !this.playerControlsVisible;
        },
        onTouchDouble: ({ zone }) => {
          if (!this.activeMediaKey || !this.playerSnapshot.canSeek) return false;
          const delta = zone === 'left' ? -PLAYER_GESTURE_CONFIG.touchSeekSeconds : PLAYER_GESTURE_CONFIG.touchSeekSeconds;
          const handled = this.player?.seek(this.playerSnapshot.currentTime + delta) === true;
          if (handled) {
            this.showPlayerGestureFeedback({
              type: 'seek',
              direction: zone,
              label: delta < 0 ? `倒退 ${Math.abs(delta)} 秒` : `快進 ${delta} 秒`,
            });
          }
          return handled;
        },
      });
    },

    setupPlayerShellObserver() {
      const shell = this.$refs.playerShell;
      if (!shell || typeof ResizeObserver !== 'function') return;
      this.playerShellObserver?.disconnect();
      this.playerShellObserver = new ResizeObserver((entries) => {
        const entry = entries.find(({ target }) => target === shell);
        if (!entry) return;
        const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
        const height = Number(borderBox?.blockSize ?? entry.contentRect.height);
        if (Number.isFinite(height) && height > 0) this.playerShellHeight = Math.round(height * 100) / 100;
      });
      this.playerShellObserver.observe(shell);
      const initialHeight = shell.getBoundingClientRect().height;
      if (initialHeight > 0) this.playerShellHeight = Math.round(initialHeight * 100) / 100;
    },

    resetPlayer() {
      if (this.activeMediaKey || this.playerSnapshot.playerState !== 'idle') this.player?.cleanup();
      Alpine.raw(this.playerGestures)?.reset();
      Alpine.raw(this.playerPlaybackCoordinator)?.cancel();
      this.clearPlayerGestureFeedback();
      this.closePlayerHelp(false);
      this.settingsOpen = false;
      this.shareOpen = false;
      this.debugOpen = false;
      this.debugEntries = [];
      this.playerControlsVisible = true;
    },

    destroyPlayer() {
      this.playerShellObserver?.disconnect();
      this.playerShellObserver = null;
      this.playerShellHeight = 0;
      Alpine.raw(this.playerGestures)?.destroy();
      this.playerGestures = null;
      Alpine.raw(this.playerPlaybackCoordinator)?.cancel();
      this.playerPlaybackCoordinator = null;
      this.clearPlayerGestureFeedback();
      this.player?.destroy();
    },

    async retryPlayer() { await this.player?.retry(); },

    togglePlayback({ showFeedback = false, forcePlay = false } = {}) {
      return Alpine.raw(this.playerPlaybackCoordinator)?.toggle({ showFeedback, forcePlay }) ?? false;
    },

    toggleMute() { this.player?.setMuted(!this.playerSnapshot.muted); },
    changePlayerVolume(event) { this.player?.setVolume(Number(event.target.value)); },
    togglePlayerBoost() { this.player?.setBoost(!this.playerSnapshot.boostEnabled); },

    changePlayerRate(event) {
      const rate = this.playerRates[Math.round(Number(event.target.value))];
      if (rate !== undefined) this.player?.setPlaybackRate(rate);
    },

    changeLowLatency(event) { this.player?.setLowLatency(event.target.checked); },

    seekPlayer(event) {
      this.player?.seek(this.playerSnapshot.timelineStart + Number(event.target.value));
    },

    playerTimelineMax() {
      return Math.max(0, this.playerSnapshot.timelineEnd - this.playerSnapshot.timelineStart);
    },

    playerTimelineValue() {
      return Math.min(this.playerTimelineMax(), Math.max(0, this.playerSnapshot.currentTime - this.playerSnapshot.timelineStart));
    },

    playerIsLoading() {
      return this.playerSnapshot.mode === 'live' && !this.playerSnapshot.userPaused
        && ['loading', 'waiting'].includes(this.playerSnapshot.playerState);
    },

    playerGestureEvent(event) {
      const rect = event.currentTarget?.getBoundingClientRect?.();
      return {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        isPrimary: event.isPrimary,
        zone: rect && event.clientX < rect.left + rect.width / 2 ? 'left' : 'right',
      };
    },

    handlePlayerPointerDown(event) {
      if (event.pointerType === 'mouse') this.playerControlsVisible = true;
      if (isPlayerGestureBlockedTarget(event.target)) {
        Alpine.raw(this.playerGestures)?.pointerCancel({ pointerId: event.pointerId });
        return;
      }
      Alpine.raw(this.playerGestures)?.pointerDown(this.playerGestureEvent(event));
    },

    handlePlayerPointerMove(event) { Alpine.raw(this.playerGestures)?.pointerMove(this.playerGestureEvent(event)); },
    handlePlayerPointerUp(event) { Alpine.raw(this.playerGestures)?.pointerUp(this.playerGestureEvent(event)); },
    handlePlayerPointerCancel(event) { Alpine.raw(this.playerGestures)?.pointerCancel(this.playerGestureEvent(event)); },

    showPlayerGestureFeedback(feedback) {
      clearTimeout(this.playerGestureFeedbackTimer);
      const current = { ...feedback, id: Date.now() };
      this.playerGestureFeedback = current;
      this.playerGestureFeedbackTimer = setTimeout(() => {
        if (this.playerGestureFeedback?.id === current.id) this.playerGestureFeedback = null;
      }, PLAYER_GESTURE_CONFIG.feedbackDuration);
    },

    clearPlayerGestureFeedback() {
      clearTimeout(this.playerGestureFeedbackTimer);
      this.playerGestureFeedbackTimer = null;
      this.playerGestureFeedback = null;
    },

    toggleShare() {
      this.shareOpen = !this.shareOpen;
      this.settingsOpen = false;
      if (this.shareOpen) this.shareIncludeTime = true;
    },

    toggleSettings() {
      this.settingsOpen = !this.settingsOpen;
      this.shareOpen = false;
      this.playerControlsVisible = true;
    },

    closePlayerPopovers() {
      if (this.playerHelpOpen) return this.closePlayerHelp();
      this.settingsOpen = false;
      this.shareOpen = false;
    },

    openPlayerHelp() {
      this.playerControlsVisible = true;
      this.settingsOpen = false;
      this.shareOpen = false;
      this.playerHelpOpen = true;
      Alpine.nextTick(() => {
        const dialog = this.$refs.playerHelpDialog;
        if (!dialog || dialog.open) return;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      });
    },

    closePlayerHelp(restoreFocus = true) {
      const wasOpen = this.playerHelpOpen || this.$refs.playerHelpDialog?.open;
      this.playerHelpOpen = false;
      const dialog = this.$refs.playerHelpDialog;
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      else dialog?.removeAttribute?.('open');
      if (!wasOpen || !restoreFocus || !this.activeMediaKey) return;
      Alpine.nextTick(() => {
        this.settingsOpen = true;
        Alpine.nextTick(() => this.$refs.playerHelpTrigger?.focus());
      });
    },

    handlePlayerHelpClosed() { this.playerHelpOpen = false; },

    async togglePictureInPicture() {
      this.settingsOpen = false;
      await this.player?.togglePictureInPicture();
    },

    async submitShare() {
      await this.player?.share({ includeTime: this.view === 'record' && this.shareIncludeTime });
    },

    toggleDebug() {
      this.debugOpen = !this.debugOpen;
      this.settingsOpen = false;
      if (this.debugOpen) this.refreshDebug();
    },

    refreshDebug() {
      const player = Alpine.raw(this.player);
      if (!player) return;
      this.debugEntries = player.getDebugEntries(this.debugFilters);
      if (this.debugAutoScroll) Alpine.nextTick(() => this.$refs.debugLog?.scrollTo({ top: this.$refs.debugLog.scrollHeight }));
    },

    clearPlayerDebug() {
      Alpine.raw(this.player)?.clearDebug();
      this.refreshDebug();
    },

    async copyPlayerDebug() {
      const json = Alpine.raw(this.player)?.exportDebug();
      if (!json || !navigator.clipboard?.writeText) {
        this.debugCopyStatus = '瀏覽器不支援複製 Debug JSON。';
        return;
      }
      try {
        await navigator.clipboard.writeText(json);
        this.debugCopyStatus = 'Debug JSON 已複製。';
      } catch {
        this.debugCopyStatus = '複製失敗，請稍後再試。';
      }
    },

    handlePlayerShortcut(event) {
      if (!this.activeMediaKey || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target?.closest?.('input, select, textarea, button, [contenteditable="true"]')) return;
      const key = event.key.toLocaleLowerCase();
      if (event.repeat && [' ', 'k', 'm', 'f'].includes(key)) return;
      if (key === ' ' || key === 'k') {
        event.preventDefault();
        this.togglePlayback();
      } else if (key === 'm') {
        event.preventDefault();
        this.toggleMute();
      } else if (key === 'f') {
        event.preventDefault();
        this.player?.toggleFullscreen();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.player?.seek(this.playerSnapshot.currentTime - 5);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.player?.seek(this.playerSnapshot.currentTime + 5);
      }
    },

    formatPlayerTime(value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
      const whole = Math.floor(seconds);
      const hours = Math.floor(whole / 3600);
      const minutes = Math.floor((whole % 3600) / 60);
      const remainder = whole % 60;
      return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
        : `${minutes}:${String(remainder).padStart(2, '0')}`;
    },

    playerTimeLabel() {
      if (this.playerSnapshot.mode === 'live') {
        if (this.playerSnapshot.atLiveEdge || (this.playerSnapshot.following && this.playerSnapshot.livePosition === null)) {
          return this.playerSnapshot.latency === null ? 'LIVE' : `LIVE · 延遲 ${this.playerSnapshot.latency.toFixed(1)} 秒`;
        }
        const behind = Math.max(0, (this.playerSnapshot.livePosition ?? 0) - this.playerSnapshot.currentTime);
        return `DVR · 落後 ${this.formatPlayerTime(behind)}`;
      }
      return `${this.formatPlayerTime(this.playerSnapshot.currentTime)} / ${this.formatPlayerTime(this.playerSnapshot.duration)}`;
    },

    formatDebugPayload(entry) {
      try { return JSON.stringify(entry.payload); } catch { return '[Unserializable]'; }
    },

    fmt(value) {
      if (value === null || value === undefined || value === '') return '—';
      if (Array.isArray(value)) {
        if (!value.length) return '—';
        return value.map(({ start, end }) => `${start.toFixed(2)}–${end.toFixed(2)}`).join(', ');
      }
      if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return '[Unserializable]'; }
      }
      return String(value);
    },
  };
}
