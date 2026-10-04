import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encrypted keystore for user wallets across chains.
 * Master key comes from VAULT_MASTER_KEY (32-byte hex) — never store it in the vault file itself.
 * Each secret is encrypted independently with AES-256-GCM (random IV per entry).
 */

interface VaultEntry {
  chain: "solana" | "evm" | "mnemonic";
  label: string;
  iv: string;      // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

interface VaultFile {
  entries: Record<string, VaultEntry>; // keyed by userId:label
}

export class WalletVault {
  private masterKey: Buffer;
  private filePath: string;
  private data: VaultFile;

  constructor(masterKeyHex: string, filePath = "./vault.json") {
    if (!masterKeyHex || masterKeyHex.length !== 64) {
      throw new Error("VAULT_MASTER_KEY must be a 32-byte value in hex (64 chars)");
    }
    this.masterKey = Buffer.from(masterKeyHex, "hex");
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): VaultFile {
    if (fs.existsSync(this.filePath)) {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    }
    return { entries: {} };
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  storeSecret(userId: string, chain: "solana" | "evm" | "mnemonic", label: string, secret: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const key = `${userId}:${label}`;
    this.data.entries[key] = {
      chain,
      label,
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    };
    this.persist();
  }

  getSecret(userId: string, label: string): string {
    const key = `${userId}:${label}`;
    const entry = this.data.entries[key];
    if (!entry) throw new Error(`No vault entry for ${key}`);

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.masterKey,
      Buffer.from(entry.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(entry.authTag, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "hex")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  listWallets(userId: string): { chain: string; label: string }[] {
    return Object.values(this.data.entries)
      .filter((e) => e.label.startsWith(userId))
      .map((e) => ({ chain: e.chain, label: e.label }));
  }

  deleteSecret(userId: string, label: string) {
    delete this.data.entries[`${userId}:${label}`];
    this.persist();
  }
}
