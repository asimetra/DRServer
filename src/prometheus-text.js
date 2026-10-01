/**
 * The Prometheus text exposition format, which every monitoring tool reads.
 *
 * Written out by hand because it is twenty lines: a help line, a type line,
 * and one line per sample. A client library would add a dependency to say the
 * same thing, and its own registry to keep in step with the numbers the server
 * already has.
 */

const escapeHelp = (text) => String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escapeLabel = (text) =>
  String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const labelsOf = (labels) => {
  const pairs = Object.entries(labels ?? {});
  return pairs.length
    ? `{${pairs.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`
    : "";
};

/**
 * `metrics` is a list of `{ name, help, type, value }`, or with `samples` — each
 * `{ labels, value }` — where one name carries several. A value that is not a
 * finite number is left out: an absent series is honest, and "NaN" is a number
 * a graph will happily draw.
 */
export const prometheusText = (metrics) => {
  const lines = [];
  for (const metric of metrics) {
    const samples = (metric.samples ?? [{ labels: null, value: metric.value }]).filter((sample) =>
      Number.isFinite(sample.value)
    );
    if (!samples.length) continue;
    lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const sample of samples) {
      lines.push(`${metric.name}${labelsOf(sample.labels)} ${sample.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
};
