import { splitTelegramText, toTelegramEntitiesText } from "./src/render.js";

const longText = "Some text before\n```\n" + "A".repeat(4000) + "\n```\nSome text after";
console.log("Input length:", longText.length);

const chunks = splitTelegramText(longText, 3500);
console.log("Chunks count:", chunks.length);

chunks.forEach((chunk, i) => {
  console.log(`Chunk ${i} length:`, chunk.length);
  const entities = toTelegramEntitiesText(chunk);
  console.log(`Chunk ${i} entities text length:`, entities.text.length);
  console.log(`Chunk ${i} entities count:`, entities.entities.length);
  if (entities.entities.length > 0) {
    console.log(`Chunk ${i} first entity:`, entities.entities[0]);
  }
});
