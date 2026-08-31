const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/** Client-side Firebase RTDB push ID (no network). */
export function generateFirebasePushId(nowMs = Date.now()): string {
  let now = nowMs;
  const timeChars: string[] = new Array(8);
  for (let i = 7; i >= 0; i--) {
    timeChars[i] = PUSH_CHARS.charAt(now % 64);
    now = Math.floor(now / 64);
  }
  let id = timeChars.join('');
  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(Math.floor(Math.random() * 64));
  }
  return id;
}
