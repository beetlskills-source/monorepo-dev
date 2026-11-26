import { z } from "zod";

/**
 * Canonical 13-digit ISBN schema. Requires exactly 13 digits with no hyphens or
 * spaces; callers holding raw user input should normalize it first with
 * `toIsbn13`.
 */
export const Isbn13Schema = z
  .string()
  .regex(/^\d{13}$/, "isbn13 must be 13 digits");
