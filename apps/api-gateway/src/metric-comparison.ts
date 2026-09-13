export type MetricTarget = {
  direction: "increase" | "decrease" | "range" | "maintain";
  value: number | null;
  min: number | null;
  max: number | null;
};

export function targetDistance(value: number, target: MetricTarget): number {
  if (target.direction === "range") {
    if (value < Number(target.min)) return Number(target.min) - value;
    if (value > Number(target.max)) return value - Number(target.max);
    return 0;
  }
  if (target.direction === "maintain") return Math.abs(value - Number(target.value));
  if (target.direction === "increase") return Math.max(0, Number(target.value) - value);
  return Math.max(0, value - Number(target.value));
}

export function compareMetric(current: number, previous: number | null, target: MetricTarget) {
  const distance = targetDistance(current, target);
  const reference = target.direction === "range" ? Math.max(Math.abs(Number(target.min)), Math.abs(Number(target.max))) : Math.abs(Number(target.value));
  const epsilon = Math.max(reference * 1e-9, 1e-9);
  const onTrack = distance <= epsilon;
  if (previous === null) {
    return {
      target_state: onTrack ? "on_track" as const : "off_track" as const,
      distance_to_target: distance,
      previous_value: null,
      change_from_previous: null,
      trend: "unknown" as const
    };
  }
  const previousDistance = targetDistance(previous, target);
  const improvement = previousDistance - distance;
  return {
    target_state: onTrack ? "on_track" as const : "off_track" as const,
    distance_to_target: distance,
    previous_value: previous,
    change_from_previous: current - previous,
    trend: improvement > epsilon ? "improving" as const : improvement < -epsilon ? "regressing" as const : "unchanged" as const
  };
}
