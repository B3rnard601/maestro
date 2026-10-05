const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

export function parseUnitsExact(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Decimals must be an integer from 0 to 255.");
  }
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError("Amount must be a plain non-negative decimal string.");
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`Amount has more than ${decimals} fractional digits.`);
  }

  const scale = 10n ** BigInt(decimals);
  const fractionalUnits = fraction ? BigInt(fraction.padEnd(decimals, "0")) : 0n;
  return BigInt(whole) * scale + fractionalUnits;
}

export function parseUnitsFloor(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Decimals must be an integer from 0 to 255.");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  if (!DECIMAL_PATTERN.test(unsigned)) {
    throw new TypeError("Amount must be a plain decimal string.");
  }
  const [whole, fraction = ""] = unsigned.split(".");
  const scale = 10n ** BigInt(decimals);
  const fractionalUnits = fraction.slice(0, decimals).padEnd(decimals, "0");
  const units = BigInt(whole) * scale + (fractionalUnits ? BigInt(fractionalUnits) : 0n);
  return negative ? -units : units;
}

export function formatUnitsExact(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Decimals must be an integer from 0 to 255.");
  }
  if (value < 0n) throw new RangeError("Amount cannot be negative.");
  if (decimals === 0) return value.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function isPositiveDecimal(value: string, decimals: number): boolean {
  try {
    return parseUnitsExact(value, decimals) > 0n;
  } catch {
    return false;
  }
}

export function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("Amount must be finite.");
  const source = value.toString();
  if (!/[eE]/.test(source)) return source;

  const isNegative = source.startsWith("-");
  const [coefficient, exponentText] = source.replace(/^-/, "").toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = whole + fraction;
  const decimalPosition = whole.length + exponent;

  const expanded = decimalPosition <= 0
    ? `0.${"0".repeat(-decimalPosition)}${digits}`
    : decimalPosition >= digits.length
      ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
      : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return isNegative ? `-${expanded}` : expanded;
}
