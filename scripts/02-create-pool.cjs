const fs = require("node:fs");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getMint } = require("@solana/spl-token");
const Decimal = require("decimal.js");
const {
  Raydium, TxVersion, DEVNET_PROGRAM_ID, DEV_API_URLS,
  getPdaAmmConfigId, getPdaPoolId, ClmmConfigLayout, PoolInfoLayout,
} = require("@raydium-io/raydium-sdk-v2");

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
  const tokens = JSON.parse(fs.readFileSync("receipts/tokens.json", "utf8"));
  const programId = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
  const configId = getPdaAmmConfigId(programId, 0).publicKey;
  const configAccount = await connection.getAccountInfo(configId);

  if (!configAccount || !configAccount.owner.equals(programId)) {
    throw new Error("Конфигурация Devnet не найдена");
  }
  const config = ClmmConfigLayout.decode(configAccount.data);
  if (config.tradeFeeRate !== 2500 || config.tickSpacing !== 60) {
    throw new Error("Параметры конфигурации изменились");
  }

  async function tokenInfo(label) {
    const address = tokens.tokens[label].mint;
    const mint = await getMint(
      connection, new PublicKey(address), "confirmed"
    );
    return {
      chainId: 101,
      address,
      programId: TOKEN_PROGRAM_ID.toBase58(),
      logoURI: "",
      symbol: `TOKEN_${label}`,
      name: `Token ${label}`,
      decimals: mint.decimals,
      tags: [],
      extensions: {},
    };
  }

  const mint1 = await tokenInfo("A");
  const mint2 = await tokenInfo("B");
  const ordered = [mint1, mint2].sort((a, b) =>
    Buffer.compare(
      new PublicKey(a.address).toBuffer(),
      new PublicKey(b.address).toBuffer()
    )
  );
  const poolId = getPdaPoolId(
    programId, configId,
    new PublicKey(ordered[0].address),
    new PublicKey(ordered[1].address)
  ).publicKey;

  fs.mkdirSync("receipts", { recursive: true });
  const filename = "receipts/pool.json";
  const previous = fs.existsSync(filename)
    ? JSON.parse(fs.readFileSync(filename, "utf8"))
    : {};
  const record = {
    network: "devnet",
    programId: programId.toBase58(),
    poolId: poolId.toBase58(),
    configId: configId.toBase58(),
    tradeFeePercent: 0.25,
    tickSpacing: 60,
    initialPrice: "1",
    mintA: ordered[0].address,
    mintB: ordered[1].address,
    explorer: `https://explorer.solana.com/address/${poolId.toBase58()}?cluster=devnet`,
    ...(previous.poolId === poolId.toBase58() && previous.signature
      ? { signature: previous.signature } : {}),
  };
  fs.writeFileSync(filename, JSON.stringify(record, null, 2));

  let account = await connection.getAccountInfo(poolId);
  if (!account) {
    const raydium = await Raydium.load({
      owner,
      connection,
      cluster: "devnet",
      disableFeatureCheck: true,
      disableLoadToken: true,
      blockhashCommitment: "confirmed",
      urlConfigs: { ...DEV_API_URLS },
    });

    const { execute, extInfo } = await raydium.clmm.createPool({
      programId,
      mint1,
      mint2,
      ammConfig: {
        id: configId,
        index: config.index,
        tradeFeeRate: config.tradeFeeRate,
        protocolFeeRate: config.protocolFeeRate,
        fundFeeRate: config.fundFeeRate,
        tickSpacing: config.tickSpacing,
        fundOwner: config.fundOwner.toBase58(),
        description: "Week 11 Devnet CLMM",
      },
      initialPrice: new Decimal(1),
      txVersion: TxVersion.LEGACY,
      computeBudgetConfig: { units: 600000, microLamports: 10000 },
    });

    if (extInfo.address.id !== poolId.toBase58()) {
      throw new Error("Расчёт адреса пула не совпал");
    }

    const { txId } = await execute({
      sendAndConfirm: true,
      skipPreflight: false,
    });
    record.signature = txId;
    record.accounts = extInfo.address;
    fs.writeFileSync(filename, JSON.stringify(record, null, 2));
    account = await connection.getAccountInfo(poolId, "confirmed");
  } else {
    console.log("Пул уже существует. Повторное создание пропущено.");
  }

  if (!account || !account.owner.equals(programId)) {
    throw new Error("Не удалось подтвердить аккаунт пула");
  }
  const state = PoolInfoLayout.decode(account.data);
  if (!state.mintA.equals(new PublicKey(record.mintA)) ||
      !state.mintB.equals(new PublicKey(record.mintB))) {
    throw new Error("Токены пула не совпадают");
  }

  console.log("Сеть: Devnet");
  console.log("Пул:", record.poolId);
  console.log("Mint A пула:", record.mintA);
  console.log("Mint B пула:", record.mintB);
  console.log("Начальная цена: 1:1");
  console.log("Комиссия обменов: 0.25%");
  console.log("Explorer:", record.explorer);
  if (record.signature) {
    console.log(
      "Транзакция:",
      `https://explorer.solana.com/tx/${record.signature}?cluster=devnet`
    );
  }
  console.log("Данные сохранены: receipts/pool.json");
}

main().then(
  () => process.exit(0),
  error => {
    console.error("Ошибка:", error.message);
    process.exit(1);
  }
);
