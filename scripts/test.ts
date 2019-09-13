Date.prototype.toJSON = function() {
  return this.toISOString();
};

function reviver(key: string, value: any) {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\S+$/.test(value)) {
      return new Date(value)
    }
  }
  return value;
}

console.log(JSON.stringify(new Date()));
console.log(JSON.parse(JSON.stringify(new Date()), reviver));
