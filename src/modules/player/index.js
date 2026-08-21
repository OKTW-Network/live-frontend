/**
 * @typedef {Object} PlayerMedia
 * @property {string} src Media source URL.
 * @property {'live' | 'recording'} kind Playback type.
 * @property {string} title Display title.
 * @property {Date} [publishedAt] Recording publication time.
 */

export { default as Player } from './Player.vue'
