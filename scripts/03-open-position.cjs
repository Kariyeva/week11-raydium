const fs = require("node:fs");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const {
  getAccount, getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const Decimal = require("decimal.js");
const BN = require("bn.js");
const {
  Raydium, TxVersion, DEV_API_URLS, DEVNET_PROGRAM_ID,
  TickUtil, LiquidityMathUtil, PersonalPositionLayout,
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
  const pool = JSON.parse(fs.readFileSync("receipts/pool.json", "utf8"));
  const programId = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
  if (pool.programId !== programId.toBase58()) {
    throw new Error("Неверная программа пула");
  }

  const filename = "receipts/position.json";

  async function verify(record) {
    const position = await connection.getAccountInfo(
      new PublicKey(record.personalPosition), "confirmed"
    );
    if (!position || !position.owner.equals(programId)) {
      throw new Error("Позиция пока не найдена. Повторно не запускай, пришли ошибку.");
    }
    const state = PersonalPositionLayout.decode(position.data);
    if (!state.poolId.equals(new PublicKey(pool.poolId)) ||
        !state.nftMint.equals(new PublicKey(record.nftMint)) ||
        state.liquidity.isZero()) {
      throw new Error("Параметры позиции требуют проверки");
    }
    if (state.tickLower !== record.tickLower ||
        state.tickUpper !== record.tickUpper) {
      throw new Error("Границы позиции не совпали");
    }

    const mintAccount = await connection.getAccountInfo(
      new PublicKey(record.nftMint), "confirmed"
    );
    if (!mintAccount) throw new Error("NFT mint не найден");
    const nftAccount = getAssociatedTokenAddressSync(
      new PublicKey(record.nftMint), owner.publicKey,
      false, mintAccount.owner
    );
    const nft = await getAccount(
      connection, nftAccount, "confirmed", mintAccount.owner
    );
    if (!nft.owner.equals(owner.publicKey) || nft.amount !== 1n) {
      throw new Error("NFT позиции не найден у владельца");
    }

    record.liquidity = state.liquidity.toString();
    record.nftAccount = nftAccount.toBase58();
    record.status = "verified";
    fs.writeFileSync(filename, JSON.stringify(record, null, 2));

    console.log("Позиция проверена.");
    console.log("Пул:", record.poolId);
    console.log("NFT mint:", record.nftMint);
    console.log("Аккаунт позиции:", record.personalPosition);
    console.log("Диапазон:", record.priceLower, "—", record.priceUpper);
    console.log("Ликвидность:", record.liquidity);
    console.log(
      "Explorer:",
      `https://explorer.solana.com/address/${record.personalPosition}?cluster=devnet`
    );
    if (record.signature) {
      console.log(
        "Транзакция:",
        `https://explorer.solana.com/tx/${record.signature}?cluster=devnet`
      );
    }
  }

  if (fs.existsSync(filename)) {
    console.log("Сохранённая позиция уже есть. Проверяем без повторного открытия.");
    await verify(JSON.parse(fs.readFileSync(filename, "utf8")));
    return;
  }

  const raydium = await Raydium.load({
    owner,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
    urlConfigs: { ...DEV_API_URLS },
  });
  const { poolInfo, poolKeys } =
    await raydium.clmm.getPoolInfoFromRpc(pool.poolId);

  if (poolInfo.programId !== programId.toBase58() ||
      poolInfo.mintA.address !== pool.mintA ||
      poolInfo.mintB.address !== pool.mintB) {
    throw new Error("Данные пула не совпадают");
  }

  const spacing = poolInfo.config.tickSpacing;
  const tickLower = Math.floor(
    TickUtil.priceToTick(
      new Decimal("0.9"), poolInfo.mintA.decimals, poolInfo.mintB.decimals
    ) / spacing
  ) * spacing;
  const tickUpper = Math.ceil(
    TickUtil.priceToTick(
      new Decimal("1.1"), poolInfo.mintA.decimals, poolInfo.mintB.decimals
    ) / spacing
  ) * spacing;

  const priceLower = TickUtil.tickToPrice(
    tickLower, poolInfo.mintA.decimals, poolInfo.mintB.decimals
  );
  const priceUpper = TickUtil.tickToPrice(
    tickUpper, poolInfo.mintA.decimals, poolInfo.mintB.decimals
  );
  const price = new Decimal(poolInfo.price);
  if (!price.gt(priceLower) || !price.lt(priceUpper)) {
    throw new Error("Цена вышла за выбранный диапазон. Нужна проверка.");
  }

  const baseAmount = new BN(1000).mul(
    new BN(10).pow(new BN(poolInfo.mintA.decimals))
  );
  const current = TickUtil.priceToSqrtPriceX64(
    price, poolInfo.mintA.decimals, poolInfo.mintB.decimals
  );
  const lower = TickUtil.getSqrtPriceAtTick(tickLower);
  const upper = TickUtil.getSqrtPriceAtTick(tickUpper);
  const calculated = LiquidityMathUtil.getLiquidityAndAmountsFromAmount({
    sqrtPriceCurrentX64: current,
    sqrtPriceLowerX64: lower,
    sqrtPriceUpperX64: upper,
    amountInfo: { type: "amountA", amount: baseAmount },
  });
  const amounts = LiquidityMathUtil.getAmountsForLiquidity(
    current, lower, upper, calculated.liquidity, true
  );
  const otherAmountMax = amounts.amountB
    .muln(101).divn(100).addn(1);

  console.log("Текущая цена:", price.toString());
  console.log("Границы:", priceLower.toString(), "—", priceUpper.toString());
  console.log("Тики:", tickLower, tickUpper);
  console.log("Вносим Mint A: 1000");
  console.log(
    "Максимум Mint B:",
    new Decimal(otherAmountMax.toString())
      .div(new Decimal(10).pow(poolInfo.mintB.decimals)).toString()
  );

  const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    tickLower,
    tickUpper,
    base: "MintA",
    ownerInfo: { useSOLBalance: false },
    baseAmount,
    otherAmountMax,
    liquidity: new BN(0),
    nft2022: true,
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: { units: 600000, microLamports: 10000 },
  });

  const record = {
    network: "devnet",
    status: "prepared",
    poolId: pool.poolId,
    owner: owner.publicKey.toBase58(),
    nftMint: extInfo.nftMint.toBase58(),
    personalPosition: extInfo.personalPosition.toBase58(),
    tickArrayLower: extInfo.tickArrayLower.toBase58(),
    tickArrayUpper: extInfo.tickArrayUpper.toBase58(),
    tickLower,
    tickUpper,
    priceAtOpen: price.toString(),
    priceLower: priceLower.toString(),
    priceUpper: priceUpper.toString(),
    baseAmount: baseAmount.toString(),
    otherAmountMax: otherAmountMax.toString(),
  };
  fs.writeFileSync(filename, JSON.stringify(record, null, 2));

  const { txId } = await execute({
    sendAndConfirm: true,
    skipPreflight: false,
  });
  record.signature = txId;
  record.status = "confirmed";
  fs.writeFileSync(filename, JSON.stringify(record, null, 2));
  await verify(record);
}

main().then(
  () => process.exit(0),
  error => {
    console.error("Ошибка:", error.stack ?? error.message);
    process.exit(1);
  }
);
