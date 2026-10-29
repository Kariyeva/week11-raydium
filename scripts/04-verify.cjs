const fs = require("node:fs");
const { Connection, PublicKey } = require("@solana/web3.js");
const {
  getAccount, getMint, getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const Decimal = require("decimal.js");
const {
  DEVNET_PROGRAM_ID, PoolInfoLayout,
  PersonalPositionLayout, TickUtil,
} = require("@raydium-io/raydium-sdk-v2");

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc || new URL(rpc).hostname !== "devnet.helius-rpc.com") {
    throw new Error("Нужен Helius Devnet RPC");
  }

  const connection = new Connection(rpc, "confirmed");
  const pool = JSON.parse(fs.readFileSync("receipts/pool.json", "utf8"));
  const position = JSON.parse(fs.readFileSync("receipts/position.json", "utf8"));
  const program = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
  const owner = new PublicKey(position.owner);

  const [poolAccount, positionAccount, nftMintAccount] =
    await connection.getMultipleAccountsInfo([
      new PublicKey(pool.poolId),
      new PublicKey(position.personalPosition),
      new PublicKey(position.nftMint),
    ], "confirmed");

  if (!poolAccount || !positionAccount || !nftMintAccount) {
    throw new Error("Один из аккаунтов не найден");
  }

  const state = PoolInfoLayout.decode(poolAccount.data);
  const personal = PersonalPositionLayout.decode(positionAccount.data);
  const nftProgram = nftMintAccount.owner;

  const [mintA, mintB, vaultA, vaultB, walletA, walletB, nft, nftMint] =
    await Promise.all([
      getMint(connection, state.mintA),
      getMint(connection, state.mintB),
      getAccount(connection, state.vaultA),
      getAccount(connection, state.vaultB),
      getAccount(connection, getAssociatedTokenAddressSync(state.mintA, owner)),
      getAccount(connection, getAssociatedTokenAddressSync(state.mintB, owner)),
      getAccount(
        connection, new PublicKey(position.nftAccount),
        "confirmed", nftProgram
      ),
      getMint(
        connection, new PublicKey(position.nftMint),
        "confirmed", nftProgram
      ),
    ]);

  const price = TickUtil.sqrtPriceX64ToPrice(
    state.sqrtPriceX64, mintA.decimals, mintB.decimals
  );

  const checks = [
    ["Пул принадлежит программе Raydium CLMM",
      poolAccount.owner.equals(program)],
    ["Позиция принадлежит программе Raydium CLMM",
      positionAccount.owner.equals(program)],
    ["Токены и конфигурация пула совпадают",
      state.mintA.toBase58() === pool.mintA &&
      state.mintB.toBase58() === pool.mintB &&
      state.configId.toBase58() === pool.configId],
    ["Позиция связана с нужным пулом и NFT",
      personal.poolId.toBase58() === pool.poolId &&
      personal.nftMint.toBase58() === position.nftMint],
    ["NFT позиции находится у владельца",
      nft.owner.equals(owner) && nft.amount === 1n &&
      nft.mint.toBase58() === position.nftMint &&
      nftMint.supply === 1n && nftMint.decimals === 0],
    ["Ликвидность позиции положительная",
      !personal.liquidity.isZero()],
    ["Границы позиции совпадают и кратны шагу тиков",
      personal.tickLower === position.tickLower &&
      personal.tickUpper === position.tickUpper &&
      personal.tickLower % pool.tickSpacing === 0 &&
      personal.tickUpper % pool.tickSpacing === 0],
    ["Текущая цена внутри диапазона, ликвидность активна",
      state.tickCurrent >= personal.tickLower &&
      state.tickCurrent < personal.tickUpper &&
      !state.liquidity.isZero()],
    ["Оба хранилища содержат нужные токены",
      vaultA.mint.equals(state.mintA) &&
      vaultB.mint.equals(state.mintB) &&
      vaultA.amount > 0n && vaultB.amount > 0n],
    ["Суммы в кошельке и пуле равны выпуску",
      walletA.amount + vaultA.amount === mintA.supply &&
      walletB.amount + vaultB.amount === mintB.supply],
  ];

  const format = (amount, decimals) =>
    new Decimal(amount.toString()).div(new Decimal(10).pow(decimals)).toString();

  console.log("Сеть: Solana Devnet");
  console.log("Пул:", pool.poolId);
  console.log("Позиция:", position.personalPosition);
  console.log("Цена Mint A в Mint B:", price.toString());
  console.log("Диапазон:", position.priceLower, "—", position.priceUpper);
  console.log("Ликвидность позиции:", personal.liquidity.toString());
  console.log("В пуле Mint A:", format(vaultA.amount, mintA.decimals));
  console.log("В пуле Mint B:", format(vaultB.amount, mintB.decimals));

  for (const [label, passed] of checks) {
    console.log(`${passed ? "OK" : "ОШИБКА"}: ${label}`);
  }

  if (checks.some(([, passed]) => !passed)) {
    throw new Error("Не все проверки пройдены");
  }

  fs.writeFileSync("receipts/verification.json", JSON.stringify({
    network: "devnet",
    checkedAt: new Date().toISOString(),
    checksPassed: checks.length,
    poolId: pool.poolId,
    personalPosition: position.personalPosition,
    currentPrice: price.toString(),
    priceLower: position.priceLower,
    priceUpper: position.priceUpper,
    liquidity: personal.liquidity.toString(),
    vaultA: state.vaultA.toBase58(),
    vaultB: state.vaultB.toBase58(),
    vaultAmountA: format(vaultA.amount, mintA.decimals),
    vaultAmountB: format(vaultB.amount, mintB.decimals),
    checks: checks.map(([label, passed]) => ({ label, passed })),
  }, null, 2));

  console.log("Все 10 проверок пройдены.");
  console.log("Результат: receipts/verification.json");
}

main().then(
  () => process.exit(0),
  error => {
    console.error("Ошибка:", error.message);
    process.exit(1);
  }
);
