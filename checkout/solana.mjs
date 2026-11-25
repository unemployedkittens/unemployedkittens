import { randomBytes } from 'node:crypto';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/addresses';
import bs58 from 'bs58';
import QRCode from 'qrcode';

export const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const atomicUnits = 1_000_000;
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const associatedTokenProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function validAddress(recipient) {
  try {
    return bs58.decode(recipient).length === 32;
  } catch {
    return false;
  }
}

function tokenBalance(balances, recipient, accountIndex) {
  const balance = balances?.find(entry =>
    entry.accountIndex === accountIndex && entry.owner === recipient && entry.mint === usdcMint
  );
  return BigInt(balance?.uiTokenAmount.amount ?? 0);
}

export async function matchesSolanaPayment(transaction, quote) {
  const meta = transaction?.meta;
  const accounts = transaction?.transaction?.message?.accountKeys;
  if (!meta || meta.err !== null || !accounts?.some(key => key.pubkey === quote.reference && !key.signer && !key.writable)) {
    return false;
  }

  const encoder = getAddressEncoder();
  const [tokenAccount] = await getProgramDerivedAddress({
    programAddress: address(associatedTokenProgram),
    seeds: [quote.recipient, tokenProgram, usdcMint].map(key => encoder.encode(address(key)))
  });
  const index = accounts.findIndex(key => key.pubkey === tokenAccount && key.writable);
  return index >= 0 && tokenBalance(meta.postTokenBalances, quote.recipient, index) -
    tokenBalance(meta.preTokenBalances, quote.recipient, index) === BigInt(quote.usdc_atoms);
}

export function createSolanaPayments({ recipient, rpcUrl = 'https://api.mainnet-beta.solana.com', request = fetch }) {
  if (!validAddress(recipient)) {
    throw new Error('The Solana receiving address must be a valid 32-byte public key.');
  }
  const rpcEndpoint = new URL(rpcUrl);
  if (rpcEndpoint.protocol !== 'https:') {
    throw new Error('The Solana RPC endpoint must use HTTPS.');
  }

  async function rpc(method, params) {
    const response = await request(rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(7_000)
    });
    if (!response.ok) throw new Error('Solana RPC unavailable.');
    const result = await response.json();
    if (result.error) throw new Error('Solana RPC returned an error.');
    return result.result;
  }

  return {
    async createQuote(feeCents) {
      const response = await request('https://api.frankfurter.dev/v2/rate/sgd/usd', {
        signal: AbortSignal.timeout(7_000)
      });
      if (!response.ok) throw new Error('The currency quote is unavailable.');
      const rate = await response.json();
      const age = Date.now() - Date.parse(rate.date);
      if (rate.base !== 'SGD' || rate.quote !== 'USD' || !Number.isFinite(rate.rate) ||
          rate.rate <= 0 || !Number.isFinite(age) || age < -86_400_000 || age > 7 * 86_400_000) {
        throw new Error('The currency quote is invalid or stale.');
      }

      return {
        reference: bs58.encode(randomBytes(32)),
        recipient,
        usdc_atoms: Math.round(feeCents * rate.rate) * 10_000
      };
    },

    async instructions(quote) {
      const amount = (quote.usdc_atoms / atomicUnits).toFixed(2);
      const params = new URLSearchParams({
        amount, 'spl-token': usdcMint, reference: quote.reference,
        label: 'UnemployedKittens', message: 'Rent a Kitten'
      });
      const uri = `solana:${quote.recipient}?${params.toString().replaceAll('+', '%20')}`;
      const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', width: 280 });
      return { amount, uri, qr };
    },

    async findPayment(quote, suppliedSignature) {
      const signatures = suppliedSignature ? [{ signature: suppliedSignature }] :
        await rpc('getSignaturesForAddress', [quote.reference, { commitment: 'finalized', limit: 6 }]);

      for (const item of signatures) {
        if (item.err) continue;
        const transaction = await rpc('getTransaction', [item.signature, {
          commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0
        }]);
        if (transaction?.transaction?.signatures?.[0] === item.signature && await matchesSolanaPayment(transaction, quote)) {
          return item.signature;
        }
      }
      return null;
    }
  };
}
