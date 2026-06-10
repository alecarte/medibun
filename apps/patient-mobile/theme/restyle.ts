import { createBox, createText, useTheme as useRestyleTheme } from "@shopify/restyle";
import type { Theme } from "./index";

/** Typed restyle primitives bound to our Theme. */
export const Box = createBox<Theme>();
export const Text = createText<Theme>();
export const useTheme = () => useRestyleTheme<Theme>();
