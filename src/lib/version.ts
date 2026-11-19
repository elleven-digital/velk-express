import pkg from "../../package.json";

/** The installed version: read from package.json when the app is built. */
export const APP_VERSION: string = pkg.version;
