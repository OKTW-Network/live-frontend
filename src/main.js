import { registerApp } from './app.js';
import './styles.css';

const scripts = [
  ['https://cdn.jsdelivr.net/npm/hls.js@1.7.1/dist/hls.min.js', 'sha384-X6qxWXYhVZFp6V31bNDBz4eOoPnZloPbOdTcnhnvRJY2+2pDMrO7R4/1mXfJ9VXY'],
  ['https://cdn.jsdelivr.net/npm/alpinejs@3.16.2/dist/cdn.min.js', 'sha384-hTDKg8MgHALzleab34+W1b6UpW6tektVmHXleL5Ztz8x2WFIJeaJp6ixjNBjbrDY'],
];

function loadScript([src, integrity]) {
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), {
      src, integrity, crossOrigin: 'anonymous', referrerPolicy: 'no-referrer',
    });
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true });
    document.head.append(script);
  });
}

document.addEventListener('alpine:init', () => registerApp(window.Alpine), { once: true });

try {
  for (const script of scripts) await loadScript(script);
} catch (error) {
  console.error(error);
  const bootError = document.querySelector('#boot-error');
  if (bootError) bootError.hidden = false;
}
