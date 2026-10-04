import { Keypair } from "@solana/web3.js";
import { Wallet as EvmWallet } from "ethers";
import Database from "better-sqlite3";
import bs58 from "bs58";
import { WalletVault } from "./wallet-vault.js";
import { generateMnemonicWallets, deriveFromMnemonic } from "./mnemonicWallet.js";
import { addWallet, getWallet, getPrimaryWallet, nextWalletLabel, deleteWallet, isLabelStillInUse } from "../db/db.js";

export const OWNER_ID = "owner"; // fallback default for direct/test calls that don't specify a real user id

export interface NewWalletResult {
  label: string;
  mnemonic: string;
  solanaAddress: string;
  evmAddress: string;
}

/**
 * Creates a brand-new wallet: one seed phrase backing both a Solana and an
 * EVM address (standard derivation paths — the same phrase would reproduce
 * these addresses in Phantom/MetaMask too). Inserts one `wallets` row per
 * chain sharing the label, since both are derived from — and reveal as —
 * the same underlying phrase.
 */
export function createMnemonicWallet(vault: WalletVault, db: Database.Database, userId: string): NewWalletResult {
  const derived = generateMnemonicWallets();
  const label = nextWalletLabel(db, userId);

  vault.storeSecret(userId, "mnemonic", label, derived.mnemonic);
  addWallet(db, { userId, chain: "solana", label, address: derived.solana.publicKey, hasMnemonic: true });
  addWallet(db, { userId, chain: "evm", label, address: derived.evm.address, hasMnemonic: true });

  return { label, mnemonic: derived.mnemonic, solanaAddress: derived.solana.publicKey, evmAddress: derived.evm.address };
}

/** Imports a wallet from an existing seed phrase — same shared-label, both-chains shape as createMnemonicWallet. */
export function importMnemonicWallet(vault: WalletVault, db: Database.Database, userId: string, mnemonicInput: string): NewWalletResult {
  const derived = deriveFromMnemonic(mnemonicInput); // throws on an invalid phrase
  const label = nextWalletLabel(db, userId);

  vault.storeSecret(userId, "mnemonic", label, derived.mnemonic);
  addWallet(db, { userId, chain: "solana", label, address: derived.solana.publicKey, hasMnemonic: true });
  addWallet(db, { userId, chain: "evm", label, address: derived.evm.address, hasMnemonic: true });

  return { label, mnemonic: derived.mnemonic, solanaAddress: derived.solana.publicKey, evmAddress: derived.evm.address };
}

/**
 * Imports a wallet from a raw key — single chain, no seed phrase to reveal
 * later (has_mnemonic stays false). Accepts a base58 64-byte secret key or a
 * JSON array of 64 numbers (Solana CLI keypair file format).
 */
export function importRawSolanaWallet(vault: WalletVault, db: Database.Database, userId: string, secretInput: string): { label: string; address: string } {
  const trimmed = secretInput.trim();
  let secretKeyBytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    secretKeyBytes = Uint8Array.from(JSON.parse(trimmed));
  } else {
    secretKeyBytes = bs58.decode(trimmed);
  }
  if (secretKeyBytes.length !== 64) {
    throw new Error(`Expected a 64-byte secret key, got ${secretKeyBytes.length} bytes`);
  }
  const kp = Keypair.fromSecretKey(secretKeyBytes); // throws if invalid

  const label = nextWalletLabel(db, userId);
  vault.storeSecret(userId, "solana", label, bs58.encode(secretKeyBytes));
  addWallet(db, { userId, chain: "solana", label, address: kp.publicKey.toBase58(), hasMnemonic: false });
  return { label, address: kp.publicKey.toBase58() };
}

/** EVM equivalent of importRawSolanaWallet — hex private key, with or without 0x. */
export function importRawEvmWallet(vault: WalletVault, db: Database.Database, userId: string, pkInput: string): { label: string; address: string } {
  const trimmed = pkInput.trim();
  const wallet = new EvmWallet(trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`); // throws if invalid

  const label = nextWalletLabel(db, userId);
  vault.storeSecret(userId, "evm", label, wallet.privateKey);
  addWallet(db, { userId, chain: "evm", label, address: wallet.address, hasMnemonic: false });
  return { label, address: wallet.address };
}

/** Loads the signing keypair for a specific labeled Solana wallet, deriving from its seed phrase if it has one. */
export function loadSolanaKeypair(vault: WalletVault, db: Database.Database, userId: string, label: string): Keypair | null {
  const row = getWallet(db, userId, "solana", label);
  if (!row) return null;
  try {
    if (row.has_mnemonic) {
      const mnemonic = vault.getSecret(userId, label);
      const derived = deriveFromMnemonic(mnemonic);
      return Keypair.fromSecretKey(bs58.decode(derived.solana.secretKeyBase58));
    }
    const secret = vault.getSecret(userId, label);
    return Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    return null;
  }
}

/** EVM equivalent of loadSolanaKeypair. */
export function loadEvmWalletByLabel(vault: WalletVault, db: Database.Database, userId: string, label: string): EvmWallet | null {
  const row = getWallet(db, userId, "evm", label);
  if (!row) return null;
  try {
    if (row.has_mnemonic) {
      const mnemonic = vault.getSecret(userId, label);
      const derived = deriveFromMnemonic(mnemonic);
      return new EvmWallet(derived.evm.privateKey);
    }
    const secret = vault.getSecret(userId, label);
    return new EvmWallet(secret);
  } catch {
    return null;
  }
}

/** The wallet every auto-trading pipeline (snipe/copy-trade/limit orders) uses for this user, per chain. */
export function getPrimarySolanaKeypair(vault: WalletVault, db: Database.Database, userId: string): Keypair | null {
  const row = getPrimaryWallet(db, userId, "solana");
  return row ? loadSolanaKeypair(vault, db, userId, row.label) : null;
}

export function getPrimaryEvmWallet(vault: WalletVault, db: Database.Database, userId: string): EvmWallet | null {
  const row = getPrimaryWallet(db, userId, "evm");
  return row ? loadEvmWalletByLabel(vault, db, userId, row.label) : null;
}

export type RevealResult = { type: "mnemonic"; value: string } | { type: "raw"; value: string };

/**
 * Decrypts and returns whatever secret backs a labeled wallet — the seed
 * phrase if it has one, otherwise the raw key. This is the only function in
 * the codebase that hands a secret back out of the vault for display rather
 * than for signing; callers are responsible for the message-exposure
 * mitigations (confirmation step, auto-delete) around showing it.
 */
export function revealSecret(vault: WalletVault, db: Database.Database, userId: string, chain: "solana" | "evm", label: string): RevealResult {
  const row = getWallet(db, userId, chain, label);
  if (!row) throw new Error("No such wallet");

  if (row.has_mnemonic) {
    return { type: "mnemonic", value: vault.getSecret(userId, label) };
  }
  return { type: "raw", value: vault.getSecret(userId, label) };
}

/**
 * Removes a wallet. A mnemonic-backed wallet has a row on both chains
 * sharing one vault entry — deleting the Solana row while the EVM row (same
 * label) still exists must NOT delete the underlying seed phrase, since the
 * EVM side still needs it to sign. The vault secret only gets purged once
 * `isLabelStillInUse` comes back false for both chains.
 */
export function eraseWallet(vault: WalletVault, db: Database.Database, userId: string, chain: "solana" | "evm", label: string): void {
  deleteWallet(db, userId, chain, label);
  if (!isLabelStillInUse(db, userId, label)) {
    vault.deleteSecret(userId, label);
  }
}
