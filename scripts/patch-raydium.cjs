const fs = require("node:fs");

const filename = require.resolve("@raydium-io/raydium-sdk-v2");
const text = fs.readFileSync(filename, "utf8");

const old = "tickArrays:Object.values(i[e])";
const fixed = "tickArrays:Object.values(i[e]||{})";

if (text.includes(fixed)) {
  console.log("Исправление SDK уже установлено.");
} else {
  if (text.split(old).length !== 2) {
    throw new Error("Ожидаемый фрагмент SDK не найден. Пришли это сообщение.");
  }

  fs.writeFileSync(filename, text.replace(old, fixed));
  console.log("SDK исправлен: пустой список массивов тиков разрешён.");
}
