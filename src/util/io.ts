import { existsSync, readFileSync, writeFileSync } from "fs"
import { DATA_DIRECTORY, createIfAbsentSync } from "./paths"
import path from "path"

/** Abstraction for saving and loading data */
export interface DataIO {
    save(data: any)
    load(): any
}

/** Creates a new file based JSON data IO */
export function fileJsonIO(fn: string): DataIO {
    const filePath = path.join(DATA_DIRECTORY, fn)
    return new class implements DataIO {
        save(data: any) {
            writeFileSync(createIfAbsentSync(filePath), JSON.stringify(data, undefined, 2))
        }

        load() {
            if (!existsSync(filePath)) {
                return { }
            }

            return JSON.parse(readFileSync(filePath).toString("utf-8"))
        }
    }
}