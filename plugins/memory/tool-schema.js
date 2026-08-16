// tool-schema.js — 插件内 defineTool：把参数 DSL 编译成标准 JSON Schema。
//
// 为什么不用宿主的 @deepseek-ai/dsh-tools？
// 插件以 junction 装入 <DSH_HOME>/profiles/node_modules/hpptools-memory 后，Node ESM
// 解析会先把 junction 落到真实路径（F:\projects\hpptools_memory\plugins\memory），
// 再沿真实路径向上找 node_modules —— 于是命中项目根目录的测试 stub
// （node_modules/@deepseek-ai/dsh-tools，版本 0.0.0-test-stub，defineTool 原样返回），
// 而不是 profile 里宿主的真实包。stub 不编译，parameters 里的 per-property
// `required: true` 会原样发给上游 provider，被按无效 JSON Schema 拒绝：
//   Invalid schema for function 'confirm': {"type":"string","required":true,...} is not of type "string"
// 这里在插件内做同款编译（等价于宿主 parameterSchemaSpecToJsonSchema 对本插件
// 参数子集的结果），不依赖模块解析结果，测试环境同样成立。
//
// 参数子集：扁平标量（string/number/integer/boolean/null）带 enum/const 与注解；
// 嵌套 object/array/oneOf 不在本插件参数使用范围内。

const ANNOTATION_KEYS = ["description", "title", "default", "examples"];
const SCALAR_KEYS = ["type", "enum", "const"];

/** 编译单个属性：剥掉 DSL 的 `required` 标志，只保留标准 JSON Schema 键。 */
function compileProperty(prop) {
  if (prop === null || typeof prop !== "object" || Array.isArray(prop)) {
    throw new Error(`defineTool: parameter property must be an object, got ${JSON.stringify(prop)}`);
  }
  const out = {};
  for (const key of [...SCALAR_KEYS, ...ANNOTATION_KEYS]) {
    if (Object.hasOwn(prop, key) && prop[key] !== undefined) out[key] = prop[key];
  }
  if (Object.hasOwn(prop, "required") && prop.required !== true) {
    throw new Error(`defineTool: parameter property .required must be true when present`);
  }
  return out;
}

/**
 * 编译隐式参数属性表为对象根 JSON Schema：
 * {type:"object", properties, required?} —— 与宿主 parameterSchemaSpecToJsonSchema 一致。
 */
export function compileParameters(parameters) {
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error("defineTool: parameters must be a property map object");
  }
  const required = [];
  const properties = {};
  for (const [name, prop] of Object.entries(parameters)) {
    if (prop && prop.required === true) required.push(name);
    properties[name] = compileProperty(prop);
  }
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * defineTool：注册前把 DSL 参数编译成标准 JSON Schema，其余字段（name/description/
 * output/execute/...）原样透传。execute 保持调用方原样（与既有 stub 行为一致）。
 */
export function defineTool(def) {
  if (def === null || typeof def !== "object") {
    throw new Error("defineTool: definition must be an object");
  }
  return {
    ...def,
    parameters: compileParameters(def.parameters),
  };
}
