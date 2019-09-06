import fs from "fs";
import SparkMD5 from "spark-md5";
import { srsMap, getNextReview, repeatReview } from "./quiz";
import QParser from "q2filter";
import uuid from "uuid/v4";
import { shuffle, ankiMustache, chunk } from "./util";
import stringify from "fast-json-stable-stringify";
import Anki from "ankisync";
import sqlite from "sqlite";
import { Collection, prop, primary, Table } from "liteorm";

@Table({name: "deck"})
class DbDeck {
  @primary({autoincrement: true}) _id?: number;
  @prop({unique: true}) name!: string;
}

@Table({name: "source"})
class DbSource {
  @primary({autoincrement: true}) _id?: number;
  @prop({unique: true}) h!: string;
  @prop() name!: string;
  @prop() created!: Date;
}

@Table<DbTemplate>({name: "template", unique: [["front", "back", "css", "js"]]})
class DbTemplate {
  @primary({autoincrement: true}) _id?: number;
  @prop() name!: string;
  @prop({references: "source(_id)", null: true}) sourceId?: number;
  @prop() front!: string;
  @prop({null: true}) back?: string;
  @prop({null: true}) css?: string;
  @prop({null: true}) js?: string;
}

@Table({name: "note"})
class DbNote {
  @primary({autoincrement: true}) _id?: number;
  @prop({unique: true}) key?: string;
  @prop() name!: string;
  @prop({references: "source(_id)", null: true}) sourceId?: number;
  @prop() data!: Record<string, any>;
  @prop() order!: Record<string, number>;
}

@Table({name: "media"})
class DbMedia {
  @primary({autoincrement: true}) _id?: number;
  @prop({unique: true}) h?: string;
  @prop({references: "source(_id)", null: true}) sourceId?: number;
  @prop() name!: string;
  @prop() data!: ArrayBuffer;
}

@Table({name: "card"})
class DbCard {
  @primary() _id!: string;
  @prop({references: "deck(_id)"}) deckId!: number;
  @prop({references: "template(_id)", null: true}) templateId?: number;
  @prop({references: "note(_id)", null: true}) noteId?: number;
  @prop() front!: string;
  @prop({null: true}) back?: string;
  @prop({null: true}) mnemonic?: string;
  @prop({null: true}) srsLevel?: number;
  @prop({null: true}) nextReview?: Date;
  @prop({null: true}) tag?: string[];
  @prop() created!: Date;
  @prop({null: true}) modified?: Date;
  @prop({null: true}) stat?: {
    streak: { right: number; wrong: number };
  };
}

export interface IEntry {
  front: string;
  deck: string;
  back?: string;
  mnemonic?: string;
  srsLevel?: number;
  nextReview?: Date;
  tag?: string[];
  created?: Date;
  modified?: Date;
  stat?: {
    streak: { right: number; wrong: number };
  };
  template?: string;
  tFront?: string;
  tBack?: string;
  css?: string;
  js?: string;
  data?: { key: string, value: any }[];
  source?: string;
  sourceH?: string;
  sCreated?: Date;
}

interface ICondOptions {
  offset?: number;
  limit?: number;
  sortBy?: string;
  desc?: boolean;
  fields?: string[];
}

interface IPagedOutput<T> {
  data: T[];
  count: number;
}

export default class R2rSqlite {
  public static async connect(filename: string) {
    const db = await sqlite.open(filename);
    const deck = await new Collection<DbDeck>(db, new DbDeck()).build();
    const source = await new Collection<DbSource>(db, new DbSource()).build();
    const template = await new Collection<DbTemplate>(db, new DbTemplate()).build();
    const note = await new Collection<DbNote>(db, new DbNote()).build();
    const media = await new Collection<DbMedia>(db, new DbMedia()).build();
    const card = await new Collection<DbCard>(db, new DbCard()).build();

    note.on("pre-create", (t) => {
      t.key = SparkMD5.hash(stringify(t.data));
    });

    note.on("pre-update", (cond: any, set: any) => {
      if (set.data) {
        set.key = SparkMD5.hash(stringify(set.data));
      }
    });

    media.on("pre-create", (t) => {
      t.h = SparkMD5.ArrayBuffer.hash(t.data);
    });

    media.on("pre-update", (cond: any, set: any) => {
      if (set.data) {
        set.h = SparkMD5.ArrayBuffer.hash(set.data);
      }
    });

    return new R2rSqlite({
      db, filename,
      deck, source, template, note, media, card
    });
  }

  public db!: sqlite.Database;
  public filename!: string;

  public deck!: Collection<DbDeck>;
  public card!: Collection<DbCard>;
  public source!: Collection<DbSource>;
  public template!: Collection<DbTemplate>;
  public note!: Collection<DbNote>;
  public media!: Collection<DbMedia>;

  private constructor(params: any) {
    for (const [k, v] of Object.entries(params)) {
      (this as any)[k] = v;
    }
  }

  public async close() {
    await this.db.close();
  }

  public async reset() {
    await Promise.all([
      this.source.delete({}),
      this.media.delete({}),
      this.template.delete({}),
      this.note.delete({}),
      this.card.delete({}),
      this.deck.delete({})
    ]);
  }

  public getTemplateKey(t: any) {
    const { front, back, css, js } = t;
    return SparkMD5.hash(stringify({ front, back, css, js }));
  }

  public getNoteKey(data: Record<string, any>) {
    return SparkMD5.hash(stringify(data));
  }

  public async parseCond(
    q: string,
    options: ICondOptions = {}
  ): Promise<IPagedOutput<any>> {
    const parser = new QParser({
      anyOf: ["template", "front", "mnemonic", "deck", "tag"],
      isString: ["template", "front", "back", "mnemonic", "deck", "tag"],
      isDate: ["created", "modified", "nextReview"],
      transforms: {
        "is:due": () => {
          return { nextReview: { $lt: new Date() } }
        }
      },
      filters: {
        "is:distinct": (items: any[]) => {
          const col: Record<string, any> = {};
          for (const it of items) {
            const k = it.key;
            if (k) {
              if (!col[k]) {
                col[k] = it;
              }
            } else {
              col[uuid()] = it;
            }
          }
          return Object.values(col);
        },
        "is:duplicate": (items: any[]) => {
          const col: Record<string, any[]> = {};
          for (const it of items) {
            const k = it.front;
            col[k] = col[k] || [];
            col[k].push(it);
          }
          return Object.values(col).filter((a) => a.length > 1).reduce((a, b) => [...a, ...b], []);
        },
        "is:random": (items: any[]) => {
          return shuffle(items);
        }
      },
      sortBy: options.sortBy,
      desc: options.desc
    });

    const fullCond = parser.getCondFull(q);

    if (!options.fields) {
      return {
        data: [],
        count: 0
      };
    }

    const allFields = new Set(options.fields || []);
    for (const f of (fullCond.fields || [])) {
      allFields.add(f);
    }

    if (q.includes("is:distinct") || q.includes("is:duplicate")) {
      allFields.add("key");
    }

    const selectClause = new Set<string>();
    const joinClause: string[] = [];

    for (const f of allFields) {
      switch (f) {
        case "order":
        case "data":
          selectClause.add(`n.${f} AS ${f}`);
          break;
        case "source":
          selectClause.add(`s.name AS source`);
          break;
        case "deck":
          selectClause.add(`d.name AS deck`);
          break;
        case "tFront":
        case "tBack":
          selectClause.add(`t.${f.substr(1).toLocaleLowerCase()} AS ${f}`);
          break;
        case "template":
          selectClause.add(`t.name AS template`);
          break;
        case "css":
        case "js":
          selectClause.add(`t.${f} AS ${f}`);
          break;
        default:
          selectClause.add(`c.${f} AS ${f}`);
      }
    }

    if (["data", "order", "source"].some((k) => allFields.has(k))) {
      joinClause.push("LEFT JOIN note n ON n._id = c.noteId");
    }

    if (["source"].some((k) => allFields.has(k))) {
      joinClause.push("LEFT JOIN source s ON s._id = n.sourceId");
    }

    if (["deck"].some((k) => allFields.has(k))) {
      joinClause.push("LEFT JOIN deck d ON d._id = c.deckId");
    }

    if (["tFront", "tBack", "template", "model", "css", "js"].some((k) => allFields.has(k))) {
      joinClause.push("LEFT JOIN template t ON t._id = c.templateId");
    }

    const data = (await this.db.all(`
    SELECT ${Array.from(selectClause).join(",")}
    FROM card c
    ${joinClause.join("\n")}`)).map((el) => {
      for (const [k, v] of Object.entries(el)) {
        if (["data", "stat", "order", "tag"].includes(k)) {
          try {
            el[k] = JSON.parse(v as string);
          } catch (e) { }
        }
      }

      return el;
    })

    let cards = parser.filter(data, q);

    let endPoint: number | undefined;
    if (options.limit) {
      endPoint = (options.offset || 0) + options.limit;
    }

    return {
      data: cards.slice(options.offset || 0, endPoint).map((c: any) => {
        if (options.fields) {
          for (const k of Object.keys(c)) {
            if (!options.fields.includes(k)) {
              delete (c as any)[k];
            }
          }
        }

        return c;
      }),
      count: cards.length
    };
  }

  public async insertMany(entries: IEntry[]): Promise<string[]> {
    entries = await Promise.all(entries.map((e) => this.transformCreateOrUpdate(null, e))) as IEntry[];

    const now = new Date();

    const sIdMap: Record<string, number> = {};
    await entries.filter((e) => e.sourceH).distinctBy((e) => e.sourceH!).mapAsync(async (el) => {
      await this.source.create({
        name: el.source!,
        created: el.sCreated || now,
        h: el.sourceH!
      }, true)
      sIdMap[el.sourceH!] = (await this.source.get({ h: el.sourceH }, ["_id"]))!._id!;
    });

    const tIdMap: Record<string, number> = {};
    await entries.filter((el) => el.template).distinctBy((el) => el.template!).mapAsync(async (el) => {
      const key = {
        front: el.tFront!,
        back: el.tBack,
        css: el.css,
        js: el.js
      };
      await this.template.create({
        ...key,
        name: el.template!,
        sourceId: el.sourceH ? sIdMap[el.sourceH] : undefined
      }, true);
      tIdMap[el.template!] = (await this.template.get(key, ["_id"]))!._id!;
    });

    const nIdMap: Record<string, number> = {};
    await entries.filter((el) => el.data).distinctBy((el) => {
      (el as any).key = SparkMD5.hash(stringify(el.data!));
      return (el as any).key;
    }).mapAsync(async (el) => {
      const data: Record<string, any> = {};
      const order: Record<string, number> = {};

      let index = 1;
      for (const { key, value } of el.data!) {
        data[key] = value;
        order[key] = index
        index++;
      }

      await this.note.create({
        name: `${el.sourceH}/${el.template}/${el.data![0].value}`,
        data,
        order,
        sourceId: el.sourceH ? sIdMap[el.sourceH] : undefined
      }, true);
      nIdMap[(el as any).key] = (await this.note.get({ data }, ["_id"]))!._id!;
    })

    const dMap: { [key: string]: number } = {};
    const decks = entries.map((e) => e.deck);
    const deckIds = await Promise.all(decks.map((d) => this.getOrCreateDeck(d)));
    decks.forEach((d, i) => {
      dMap[d] = deckIds[i];
    });

    const cIds: string[] = [];
    entries.map((e) => {
      const _id = uuid();
      cIds.push(_id);
      this.card.create({
        _id,
        front: e.front,
        back: e.back,
        mnemonic: e.mnemonic,
        srsLevel: e.srsLevel,
        nextReview: e.nextReview,
        deckId: dMap[e.deck],
        noteId: nIdMap[(e as any).key],
        templateId: tIdMap[e.template!],
        created: now,
        tag: e.tag
      });
    });

    return cIds;
  }

  public async updateMany(ids: string[], u: Partial<IEntry>) {
    const now = new Date();

    const cs = await (await this.card.find({ _id: { $in: ids } }, ["_id", ...Object.keys(u) as any[]]))
      .mapAsync(async (c) => {
        const c0: any = Object.assign(c, await this.transformCreateOrUpdate(c._id!, u, now));
        const c1: any = { _id: c._id! };

        for (let [k, v] of Object.entries(c0)) {
          switch (k) {
            case "deck":
              k = "deckId",
                v = await this.getOrCreateDeck(v as string);
              c1[k] = v;
              break;
            case "tFront":
            case "tBack":
              k = k.substr(1).toLocaleLowerCase();
            case "css":
            case "js":
              const { templateId } = (await this.card.get({ _id: c._id! }, ["templateId"]))!;
              await this.template.update({ _id: templateId }, { [k]: v });
              break;
            case "data":
              const noteId = (await this.card.get({ _id: c._id! }, ["noteId"]))!.noteId!;
              const n = await this.note.get({ key: noteId }, ["order", "data"]);
              if (n) {
                const { order, data } = n;
                for (const { key, value } of v as any[]) {
                  if (!order![key]) {
                    order![key] = Math.max(...Object.values(order!)) + 1;
                  }
                  data![key] = value;
                }
                await this.note.update({ key: noteId }, { order, data });
              } else {
                const order: Record<string, number> = {};
                const data: Record<string, any> = {};
                for (const { key, value } of v as any[]) {
                  if (!order[key]) {
                    order[key] = Math.max(-1, ...Object.values(order)) + 1;
                  }
                  data[key] = value;
                }

                const key = this.getNoteKey(data)
                const name = `${key}/${Object.values(data)[0]}`;
                await this.note.create({ key, name, order, data });
                c1.noteId = key;
              }
              break;
            default:
              c1[k] = v;
          }
        }

        return c1;
      });

    for (const c of cs) {
      if (Object.keys(c).length > 1) {
        await this.card.update({ _id: c._id }, c);
      }
    }
  }

  public async addTags(ids: string[], tags: string[]) {
    const now = new Date();
    await Promise.all((await this.card.find({ _id: { $in: ids } }, ["_id", "tag"])).map((c) => {
      c.modified = now;
      c.tag = c.tag || [];
      for (const t of tags) {
        if (!c.tag.includes(t)) {
          c.tag.push(t);
        }
      }
      return this.card.update({ _id: c._id! }, c);
    }));
  }

  public async removeTags(ids: string[], tags: string[]) {
    const now = new Date();
    await Promise.all((await this.card.find({ _id: { $in: ids } }, ["_id", "tag"])).map((c) => {
      c.modified = now;
      const newTags: string[] = [];

      for (const t of (c.tag || [])) {
        if (!tags.includes(t)) {
          newTags.push(t);
        }
      }

      c.tag = newTags;

      return this.card.update({ _id: c._id! }, c);
    }));
  }

  public deleteMany(ids: string[]) {
    return this.card.delete({ _id: { $in: ids } });
  }

  public async render(cardId: string) {
    const r = await this.parseCond(`_id=${cardId}`, {
      limit: 1,
      fields: ["front", "back", "mnemonic", "tFront", "tBack", "data", "css", "js"]
    });

    const c = r.data[0];
    const { tFront, tBack, data } = c;

    if (/@md5\n/.test(c.front)) {
      c.front = ankiMustache(tFront || "", data);
    }

    if (c.back && /@md5\n/.test(c.back)) {
      c.back = ankiMustache(tBack || "", data, c.front);
    }

    return c;
  }

  public markRight(cardId: string) {
    return this.updateSrsLevel(+1, cardId);
  }

  public markWrong(cardId: string) {
    return this.updateSrsLevel(-1, cardId);
  }

  private async updateSrsLevel(dSrsLevel: number, cardId: string) {
    const card = await this.card.get({ _id: cardId }, ["srsLevel", "stat"]);

    if (!card) {
      return;
    }

    card.srsLevel = card.srsLevel || 0;
    card.stat = card.stat || {
      streak: {
        right: 0,
        wrong: 0
      }
    };
    card.stat.streak = card.stat.streak || {
      right: 0,
      wrong: 0
    }

    if (dSrsLevel > 0) {
      card.stat.streak.right = (card.stat.streak.right || 0) + 1;
    } else if (dSrsLevel < 0) {
      card.stat.streak.wrong = (card.stat.streak.wrong || 0) + 1;
    }

    card.srsLevel += dSrsLevel;

    if (card.srsLevel >= srsMap.length) {
      card.srsLevel = srsMap.length - 1;
    }

    if (card.srsLevel < 0) {
      card.srsLevel = 0;
    }

    if (dSrsLevel > 0) {
      card.nextReview = getNextReview(card.srsLevel);
    } else {
      card.nextReview = repeatReview();
    }

    const { srsLevel, stat, nextReview } = card;
    this.updateMany([cardId], { srsLevel, stat, nextReview });
  }

  private async transformCreateOrUpdate(
    cardId: string | null,
    u: Partial<IEntry>,
    timestamp: Date = new Date()
  ): Promise<Partial<IEntry>> {
    let data: { key: string, value: any }[] | null = null;
    let front: string = "";

    if (!cardId) {
      u.created = timestamp;
    } else {
      u.modified = timestamp;
    }

    if (u.front && u.front.startsWith("@template\n")) {
      if (!data) {
        if (cardId) {
          data = await this.getOrderedData(cardId);
        } else {
          data = u.data || [];
        }
      }

      u.tFront = u.front.substr("@template\n".length);
    }

    if (u.tFront) {
      front = ankiMustache(u.tFront, data || {});
      u.front = "@md5\n" + SparkMD5.hash(front);
    }

    if (u.back && u.back.startsWith("@template\n")) {
      if (!data) {
        if (cardId) {
          data = await this.getOrderedData(cardId);
        } else {
          data = u.data || [];
        }
      }

      u.tBack = (u.back || "").substr("@template\n".length);
      if (!front && cardId) {
        front = await this.getFront(cardId);
      }
    }

    if (u.tBack) {
      const back = ankiMustache(u.tBack, data || {}, front);
      u.back = "@md5\n" + SparkMD5.hash(back);
    }

    return u;
  }

  private async getOrCreateDeck(name: string): Promise<number> {
    try {
      return await this.deck.create({ name });
    } catch (e) {
      return (await this.deck.get({ name }, ["_id"]))!._id!;
    }
  }

  private async getData(cardId: string): Promise<Record<string, any> | null> {
    const c = await this.card.get({ _id: cardId }, ["noteId"]);
    if (c && c.noteId) {
      const n = await this.note.get({ key: c.noteId }, ["data"]);
      if (n) {
        return n.data || null;
      }
    }

    return null;
  }

  private async getOrderedData(cardId: string): Promise<{ key: string, value: any }[]> {
    const output: { key: string, value: any }[] = [];

    const c = await this.card.get({ _id: cardId }, ["noteId"]);
    if (c && c.noteId) {
      const n = await this.note.get({ key: c.noteId }, ["data", "order"]);
      if (n) {
        for (const [k, v] of Object.entries(n.data!)) {
          output[n.order![k]] = {
            key: k,
            value: v
          };
        }
      }
    }

    return output;
  }

  private async getFront(cardId: string): Promise<string> {
    const c = await this.card.get({ _id: cardId }, ["front", "templateId"]);
    if (c && c.front) {
      if (c.front.startsWith("@md5\n") && c.templateId) {
        const t = await this.template.get({ name: c.templateId }, ["front"]);
        if (t) {
          const data = await this.getData(cardId);
          return ankiMustache(t.front!, data || {});
        }
      }

      return c.front;
    }

    return "";
  }

  public async fromR2r(r2r: R2rSqlite, options?: { filename?: string, callback?: (p: IProgress) => void }) {
    const filename = options ? options.filename : undefined;
    const callback = options ? options.callback : undefined;

    if (callback) callback({ text: "Reading R2r file" });

    const data = fs.readFileSync(r2r.filename);
    const sourceH = SparkMD5.ArrayBuffer.hash(data);
    const now = new Date();
    let sourceId: number;

    try {
      sourceId = await this.source.create({
        name: filename || r2r.filename,
        h: sourceH,
        created: now
      });
    } catch (e) {
      if (callback) callback({ text: "Duplicated resource" });
      return;
    }

    await Promise.all((await r2r.media.find({}, ["name", "data"])).map((m) => {
      return this.media.create({
        name: m.name!,
        data: m.data!,
        sourceId
      }, true);
    }));

    const deckIdMap: Record<string, number> = {};

    await ((await r2r.deck.find({}, ["name"])).map(async (d) => {
      try {
        deckIdMap[d.name!] = await this.deck.create({
          name: d.name!
        });;
      } catch (e) {
        deckIdMap[d.name!] = (await this.deck.get({ name: d.name }, ["_id"]))!._id!;
      }
    }));

    await Promise.all((await r2r.template.find({})).map((t) => {
      return this.template.create({
        ...t,
        front: t.front!,
        name: `${sourceH}/${t.name}`
      }, true);
    }));

    await Promise.all((await r2r.note.find({})).map((n) => {
      return this.note.create(n as any, true);
    }));

    await Promise.all((await r2r.card.find({})).map((c) => {
      return this.card.create(c as any, true);
    }));
  }

  public async getMedia(h: string): Promise<ArrayBuffer | null> {
    const m = await this.media.get({ h }, ["data"]);
    if (m) {
      return m.data!;
    }

    return null;
  }

  public async fromAnki(anki: Anki, options?: { filename?: string, callback?: (p: IProgress) => void }) {
    const filename = options ? options.filename : undefined;
    const callback = options ? options.callback : undefined;

    if (callback) callback({ text: "Reading Anki file" });

    const data = fs.readFileSync(anki.filePath);
    const now = new Date();
    let sourceId: number;
    const sourceH = SparkMD5.ArrayBuffer.hash(data);

    try {
      sourceId = await this.source.create({
        name: filename || anki.filePath,
        h: sourceH,
        created: now
      });
    } catch (e) {
      if (callback) callback({ text: "Duplicated Anki resource" });
      return;
    }

    let current: number;
    let max: number;

    const media = await anki.apkg.tables.media.all();
    current = 0;
    max = media.length;
    await media.mapAsync(async (el) => {
      if (callback) callback({ text: "Inserting media", current, max });

      await this.media.create({
        h: el.h,
        name: el.name,
        data: el.data,
        sourceId
      }, true);

      current++;
    });

    const card = await anki.apkg.tables.cards.all();
    const dIdMap: Record<string, number> = {};
    const tIdMap: Record<string, number> = {};
    const nIdMap: Record<string, number> = {};

    current = 0;
    max = card.length;

    for (const c of chunk(card, 1000)) {
      if (callback) callback({ text: "Inserting cards", current, max });

      await c.mapAsync(async (el) => {
        if (!Object.keys(dIdMap).includes(el.deck.name)) {
          const name = el.deck.name;
          await this.deck.create({ name }, true);
          dIdMap[name] = (await this.deck.get({ name }, ["_id"]))!._id!;
        }

        const t = {
          name: `${sourceH}/${el.note.model.name}/${el.template.name}`,
          front: el.template.qfmt,
          back: el.template.afmt,
          css: el.note.model.css
        };
        const templateKey = this.getTemplateKey(t);
        if (!Object.keys(tIdMap).includes(templateKey)) {
          await this.template.create({
            ...t,
            sourceId
          }, true);
          tIdMap[templateKey] = (await this.template.get(t, ["_id"]))!._id!;
        }

        const data: Record<string, string> = {};
        const order: Record<string, number> = {};
        el.template.model.flds.forEach((k, i) => {
          data[k] = el.note.flds[i];
          order[k] = i;
        });
        const key = this.getNoteKey(data);
        if (!Object.keys(nIdMap).includes(key)) {
          await this.note.create({
            key,
            name: `${sourceH}/${el.note.model.name}/${el.template.name}/${el.note.flds[0]}`,
            data,
            order,
            sourceId
          }, true);
          nIdMap[key] = (await this.note.get({ key }, ["_id"]))!._id!;
        }

        const front = ankiMustache(el.template.qfmt, data);
        const back = ankiMustache(el.template.afmt, data, front);

        await this.card.create({
          _id: uuid(),
          deckId: dIdMap[el.deck.name],
          templateId: tIdMap[templateKey],
          noteId: nIdMap[key],
          front: `@md5\n${SparkMD5.hash(front)}`,
          back: `@md5\n${SparkMD5.hash(back)}`,
          created: now,
          tag: el.note.tags
        }, true);
      });

      current += 1000;
    };
  }
}

interface IProgress {
  text: string;
  current?: number;
  max?: number;
}