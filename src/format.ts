import Anki from "ankisync";
import SparkMD5 from "spark-md5";
import stringify from "fast-json-stable-stringify";
import R2rSqlite from ".";

export type ISortedData = Array<{ key: string, value: any }>;

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
  data?: ISortedData;
  source?: string;
  sH?: string;
  sCreated?: Date;
}

export interface IRender {
  front: string;
  back?: string;
  mnemonic?: string;
  tFront?: string;
  tBack?: string;
  data: ISortedData;
  css?: string;
  js?: string;
}

export interface ICondOptions<T extends Record<string, any>> {
  offset?: number;
  limit?: number;
  sortBy?: keyof T | "random";
  desc?: boolean;
  fields?: Array<keyof T> | "*";
}

export interface IPagedOutput<T> {
  data: T[];
  count: number;
}

abstract class R2rFormat {
  abstract async build(): Promise<this>;
  abstract async close(): Promise<this>;
  abstract async reset(): Promise<this>;
  abstract async parseCond(
    q: string,
    options: ICondOptions<IEntry>
  ): Promise<IPagedOutput<Partial<IEntry>>>;
  abstract async insertMany(entries: IEntry[]): Promise<string[]>;
  abstract async updateMany(ids: string[], u: Partial<IEntry>): Promise<void>;
  abstract async addTags(ids: string[], tags: string[]): Promise<void>;
  abstract async removeTags(ids: string[], tags: string[]): Promise<void>;
  abstract async deleteMany(ids: string[]): Promise<void>;
  abstract async render(cardId: string): Promise<IRender>;
  abstract async getMedia(h: string): Promise<ArrayBuffer | null>;
  abstract async fromR2r(r2r: R2rSqlite, options?: { filename?: string, callback?: (p: IProgress) => void }): Promise<void>;
  abstract async export(r2r: R2rSqlite, q: string, 
    options?: { callback?: (p: IProgress) => void }): Promise<void>;
  abstract async fromAnki(anki: Anki, options?: { filename?: string, callback?: (p: IProgress) => void }): Promise<void>;

  protected abstract async updateSrsLevel(dSrsLevel: number, cardId: string): Promise<void>;
  protected abstract async transformCreateOrUpdate(
    cardId: string | null,
    u: Partial<IEntry>,
    timestamp: Date
  ): Promise<Partial<IEntry>>;
  protected abstract async getOrCreateDeck(name: string): Promise<number>;
  protected abstract async getData(cardId: string): Promise<ISortedData | null>;
  protected abstract async getFront(cardId: string): Promise<string>;

  public fromSortedData(sd: ISortedData) {
    const data: Record<string, any> = {};
    const order: Record<string, number> = {};

    let index = 1;
    for (const { key, value } of sd) {
      data[key] = value;
      order[key] = index
      index++;
    }
    return {data, order};
  }

  public toSortedData(d: {data: Record<string, any>, order: Record<string, number>}): ISortedData {
    const {data, order} = d;

    return Object.keys(order).sort((a, b) => {
      return order[b] - order[a];
    }).map((key) => {
      return {
        key,
        value: data[key]
      };
    });
  }

  public markRight(cardId: string) {
    return this.updateSrsLevel(+1, cardId);
  }

  public markWrong(cardId: string) {
    return this.updateSrsLevel(-1, cardId);
  }

  public getTemplateKey(t: any) {
    const { front, back, css, js } = t;
    return SparkMD5.hash(stringify({ front, back, css, js }));
  }

  public getNoteKey(data: Record<string, any>) {
    return SparkMD5.hash(stringify(data));
  }
}

export abstract class R2rLocal extends R2rFormat {
  protected filename: string;

  constructor(filename: string) {
    super();
    this.filename = filename;
  }
}

export interface IProgress {
  text: string;
  current?: number;
  max?: number;
}