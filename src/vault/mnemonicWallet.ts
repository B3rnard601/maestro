import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import { HDNodeWallet } from "ethers";
import bs58 from "bs58";

// Standard derivation paths — same ones Phantom/Solflare (Solana) and
// MetaMask/most EVM wallets (BIP-44 default) use, so a phrase generated here
// derives the same addresses if ever imported into a real wallet app, and
// vice versa.
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";
const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0";

export interface DerivedWallets {
  mnemonic: string;
  solana: { publicKey: string; secretKeyBase58: string };
  evm: { address: string; privateKey: string };
}

/** Generates a new 12-word seed phrase and derives both chains' keys from it. */
export function generateMnemonicWallets(): DerivedWallets {
  const mnemonic = bip39.generateMnemonic(); // 128-bit entropy → 12 words
  return deriveFromMnemonic(mnemonic);
}

/** Derives both chains' keys from an existing seed phrase (import path). */
export function deriveFromMnemonic(mnemonic: string): DerivedWallets {
  const trimmed = mnemonic.trim().toLowerCase();
  if (!bip39.validateMnemonic(trimmed)) {
    throw new Error("Invalid seed phrase — check the word count (12 or 24) and spelling");
  }

  const seed = bip39.mnemonicToSeedSync(trimmed);

  const solanaDerived = derivePath(SOLANA_DERIVATION_PATH, seed.toString("hex")).key;
  const solanaKeypair = Keypair.fromSeed(solanaDerived);

  const evmNode = HDNodeWallet.fromSeed(seed).derivePath(EVM_DERIVATION_PATH.replace("m/", ""));

  return {
    mnemonic: trimmed,
    solana: {
      publicKey: solanaKeypair.publicKey.toBase58(),
      secretKeyBase58: bs58.encode(solanaKeypair.secretKey),
    },
    evm: {
      address: evmNode.address,
      privateKey: evmNode.privateKey,
    },
  };
}
