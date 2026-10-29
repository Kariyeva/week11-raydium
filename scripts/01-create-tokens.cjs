const fs = require("node:fs");
const {
  Connection, Keypair, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, MINT_SIZE, getMint, getAccount,
  getMinimumBalanceForRentExemptMint,
  getAssociatedTokenAddressSync,
  createInitializeMintInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
} = require("@solana/spl-token");

const options = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
};

function loadOrCreateKey(filename) {
  if (fs.existsSync(filename)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(filename, "utf8")))
    );
  }
  const key = Keypair.generate();
  fs.writeFileSync(
    filename, JSON.stringify(Array.from(key.secretKey)),
    { mode: 0o600, flag: "wx" }
  );
  return key;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc || new URL(rpc).hostname !== "devnet.helius-rpc.com") {
    throw new Error("Нужен Helius Devnet RPC");
  }
  const connection = new Connection(rpc, "confirmed");
  const owner = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(
      "/home/huawei/.config/solana/id.json", "utf8"
    ))
  ));

  fs.mkdirSync("keys", { recursive: true });
  fs.mkdirSync("receipts", { recursive: true });

  const outputFile = "receipts/tokens.json";
  const result = fs.existsSync(outputFile)
    ? JSON.parse(fs.readFileSync(outputFile, "utf8"))
    : { network: "devnet", owner: owner.publicKey.toBase58(), tokens: {} };

  const decimals = 6;
  const amount = 1_000_000n * 10n ** BigInt(decimals);

  for (const label of ["A", "B"]) {
    const mint = loadOrCreateKey(`keys/token-${label}.json`);
    const ata = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey);
    const exists = await connection.getAccountInfo(mint.publicKey, "confirmed");
    let signature = result.tokens[label]?.signature;

    if (!exists) {
      const rent = await getMinimumBalanceForRentExemptMint(
        connection, "confirmed"
      );

      const transaction = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports: rent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
          mint.publicKey, decimals, owner.publicKey, null
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          owner.publicKey, ata, owner.publicKey, mint.publicKey
        ),
        createMintToCheckedInstruction(
          mint.publicKey, ata, owner.publicKey, amount, decimals
        )
      );

      signature = await sendAndConfirmTransaction(
        connection, transaction, [owner, mint], options
      );
    } else {
      console.log(`Token ${label} уже создан, повторный выпуск пропущен.`);
    }

    const info = await getMint(connection, mint.publicKey, "confirmed");
    const account = await getAccount(connection, ata, "confirmed");

    if (info.decimals !== decimals || info.supply !== amount) {
      throw new Error(`Неожиданные параметры Token ${label}`);
    }
    if (!account.owner.equals(owner.publicKey) ||
        !account.mint.equals(mint.publicKey) ||
        account.amount !== amount) {
      throw new Error(`Нужна проверка баланса Token ${label}`);
    }

    result.tokens[label] = {
      mint: mint.publicKey.toBase58(),
      tokenAccount: ata.toBase58(),
      decimals,
      supply: "1000000",
      balance: "1000000",
      ...(signature ? { signature } : {}),
      explorer: `https://explorer.solana.com/address/${mint.publicKey.toBase58()}?cluster=devnet`,
    };
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

    console.log(`\nToken ${label}`);
    console.log("Mint:", mint.publicKey.toBase58());
    console.log("Баланс: 1000000");
    console.log("Explorer:", result.tokens[label].explorer);
  }

  console.log("\nОба токена проверены. Адреса: receipts/tokens.json");
}

main().then(
  () => process.exit(0),
  error => {
    console.error("Ошибка:", error.message);
    process.exit(1);
  }
);
