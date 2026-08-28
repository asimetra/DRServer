/**
 * One place that knows both environment prefixes.
 *
 * `ODS_` is the public name and `DR_` is what the project was called before it
 * had one. Deployments and shell histories still carry the old spelling, so it
 * keeps working rather than failing on a rename nobody outside this repository
 * asked for.
 *
 * It lives in its own module because the tools need it too, and a helper hidden
 * inside config.js meant every script outside that file quietly supported only
 * the legacy prefix — documented as `ODS_`, ignored in practice.
 */
export const envSetting = (name, environment = process.env) =>
  environment[`ODS_${name}`] ?? environment[`DR_${name}`];

/** The same lookup for switches that are on when set to "1". */
export const envFlag = (name, environment = process.env) => envSetting(name, environment) === "1";
