import { z } from "zod";

/** MVP bill categories. Cash allowances and school fees are out of scope. */
export const Category = z.enum(["electricity", "airtime", "data", "tv"]);
export type Category = z.infer<typeof Category>;

export const CATEGORIES = Category.options;
