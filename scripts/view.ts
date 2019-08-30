import R2r from "../src";

(async () => {
  const r2r = await R2r.connect("test.r2r");
  console.log(await r2r.card.find("*", {}, "LIMIT 10"));
  console.log(await r2r.note.find("*", {}, "LIMIT 10"));
  console.log(await r2r.template.find("*", {}, "LIMIT 10"));
  console.log(await r2r.source.find("*", {}, "LIMIT 10"));
  console.log(await r2r.deck.find("*", {}, "LIMIT 10"));
  console.log(await r2r.media.find("*", {}, "LIMIT 10"));
  await r2r.close();
})().catch(console.error);
