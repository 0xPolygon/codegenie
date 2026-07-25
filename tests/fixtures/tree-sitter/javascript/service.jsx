import "./polyfill.js";
const legacy = require("./legacy.cjs");
export { normalize } from "./normalize.js";
import fetchRecord from "./fetch-record.js";
require("./polyfill.js");
require(dynamicModuleName);

export const SERVICE_VERSION = "1.0";

export async function loadRecord(id) {
  return fetchRecord(id);
}

export function* streamRecords(records) {
  yield* records;
}

export const makeLoader = (transport) => async (id) => {
  return transport(id);
};

export class RecordService {
  #token = "secret";
  #refresh = async () => this.#token;

  constructor(transport) {
    this.transport = transport;
  }

  async load(id) {
    return this.transport(id);
  }

  render = (record) => <span>{record.name}</span>;
}

export const ExpressionService = class {
  execute(input) {
    return input;
  }
};

module.exports.legacy = legacy;
export * as helpers from "./helpers.js";
