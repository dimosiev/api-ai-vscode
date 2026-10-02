// Creates the key pair that signs releases.
//
//   npm run signing-key            # the first key
//   npm run signing-key -- --add   # a second key, when replacing a lost or leaked one
//
// The public half goes into packages/core/src/update-key.ts (committed, built
// into the extension and the CLI). The private half is written ONCE to a file
// on the Desktop: move it into the password manager and delete the file.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { root } from "./release-config.mjs";

const keyFile = join(root, "packages/core/src/update-key.ts");
const LIST = /export const UPDATE_PUBLIC_KEYS: string\[\] = \[[^\]]*\];/;
const text = readFileSync(keyFile, "utf8");
if (!LIST.test(text)) throw new Error(`Не нашёл список ключей в ${keyFile}.`);
const existing = [...text.match(LIST)[0].matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((m) => m[1]);

if (existing.length && !process.argv.includes("--add")) {
  console.error("Ключ подписи уже создан. Новый нужен, только если старый потерян или украден: npm run signing-key -- --add");
  process.exit(1);
}
if (existing.length >= 2) {
  console.error(`В ${keyFile} уже два ключа. Сначала удалите оттуда старый.`);
  process.exit(1);
}

const out = join(homedir(), "Desktop", "dimosi-signing-key.txt");
if (existsSync(out)) {
  console.error(`Файл ${out} уже есть. Перенесите ключ из него в менеджер паролей, удалите файл и запустите снова.`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");

writeFileSync(
  out,
  `Ключ подписи обновлений dimosi (закрытый). Создан ${new Date().toISOString().slice(0, 10)}.

1. Скопируйте строку ниже в Bitwarden: новая запись «dimosi — ключ подписи», поле «Пароль».
2. Удалите этот файл и очистите Корзину.
3. Никому не показывайте ключ и не кладите его в проект или на сервер.

${priv}
`,
  { mode: 0o600, flag: "wx" },
);

const keys = [...existing, pub];
writeFileSync(keyFile, text.replace(LIST, `export const UPDATE_PUBLIC_KEYS: string[] = [\n${keys.map((k) => `  "${k}",`).join("\n")}\n];`));

console.log(`✔ Закрытый ключ записан в ${out}`);
console.log("  Перенесите его в Bitwarden и удалите файл.");
console.log(`✔ Открытый ключ добавлен в ${keyFile} — его нужно закоммитить.`);
