// Passphrase encryption for the demo data. Runs in the browser and in Node.
// AES-GCM with a key derived by PBKDF2, so the site holds only ciphertext.

const ITERATIONS = 310000;

const toB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.trim()), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(value, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return { v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

// Throws when the passphrase is wrong: AES-GCM authenticates the ciphertext.
export async function unseal(sealed, passphrase) {
  const key = await deriveKey(passphrase, fromB64(sealed.salt));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv) }, key, fromB64(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
