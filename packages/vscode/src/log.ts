import { Log } from "@dimosi/core";

/**
 * The extension's journal, shown in View → Output → dimosi. Shared by all
 * modules; activate() connects it to the output channel.
 */
export const log = new Log();
