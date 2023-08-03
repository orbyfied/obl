import { existsSync, mkdirSync, writeFileSync } from "fs"
import path from "path"

/** Resolves the given path to something usable */
export function resolvePath(pathStr: string) {
    return !path.isAbsolute(pathStr) ? path.join(process.cwd(), pathStr).replace("\\", "/") : pathStr
}

/** Create the given path if it does not exist,
 *  returns the path back */
export function createIfAbsentSync(pathStr: string): string {
    if (existsSync(pathStr)) {
        return pathStr
    }

    let dir = path.dirname(pathStr)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }

    writeFileSync(pathStr, "")
    return pathStr
}

/** The data directory for the program */
export const DATA_DIRECTORY = "./data/"

/** The configuration directory for the program */
export const CONFIG_DIRECTORY = "./config/"