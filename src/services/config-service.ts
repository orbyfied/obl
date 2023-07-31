import { BotService, autoRegister } from "../services";
import * as fs from 'fs'
import { resolvePath } from "../util/paths";
import yaml from 'yaml'

/** An error related to config loading */
export class ConfigLoadError extends Error {
    constructor(msg: string, cause: Error) {
        super(msg)
        this.cause = cause
    }
}

function removeFromArray(arr: any[], val: any) {
    let index = arr.indexOf(val);
    if (index > -1) {
        arr.splice(index, 1);
    }

    return arr;
}

/** Abstraction for the IO of configs */
export interface ConfigParser {
    /**
     * Loads the configuration from the given string.
     * @param str The string
     */
    load(str: string): object

    /**
     * Saves the given configuration data to a string.
     * @param data The data
     */
    save(data: object): string
}

// JSON configuration parser implementation
export class JsonConfigParser implements ConfigParser {
    static standard(): JsonConfigParser {
        return JSON_CONFIG_PARSER
    }

    load(str: string): object {
        return JSON.parse(str)
    }
    
    save(data: object): string {
        return JSON.stringify(data, null, 4)
    }
}

export class YamlConfigParser implements ConfigParser {
    static standard(): YamlConfigParser {
        return YAML_CONFIG_PARSER
    }

    load(str: string): object {
        return yaml.parse(str)
    }

    save(data: object): string {
        return yaml.stringify(data)
    }
}

/** The default JSON config parser instance */
const JSON_CONFIG_PARSER: JsonConfigParser = new JsonConfigParser()
const YAML_CONFIG_PARSER: YamlConfigParser = new YamlConfigParser()

/** Saves the given config data to the given file */
export function saveConfigToFile(data: object, file: string, parser: ConfigParser = YAML_CONFIG_PARSER) {
    file = resolvePath(file)

    // serialize the data
    let str = parser.save(data)

    // write the data to a file
    fs.writeFileSync(file, str)
}

/** Loads the config from the given file and updates it following the template file */
export function loadConfigFromFile(fileRel: string, templateFileRel: string, parser: ConfigParser = YAML_CONFIG_PARSER): object {
    try {
        let file = resolvePath(fileRel)
        let templateFile = resolvePath(templateFileRel)
        
        // load template
        let template: object = parser.load(fs.readFileSync(templateFile).toString("utf-8"))

        // just copy template file if file doesnt exist
        if (!fs.existsSync(file)) {
            fs.copyFileSync(templateFile, file)
            return template
        }

        // load actual and update following the template,
        // then save the result if it changed
        let actual: object = parser.load(fs.readFileSync(file).toString("utf-8"))
        if (updateConfigSchema(template, actual)) {
            saveConfigToFile(actual, file, parser)
        }

        // return data
        return actual
    } catch (e) {
        throw new ConfigLoadError("While loading config " + fileRel, e)
    }
}

/** Updates the schema in the actual data to match the template,
  * Removing keys not in the template and settings missing defaults. 
  * Returns whether it changed something. */
export function updateConfigSchema(template: object, actual: object): boolean {
    let changed = false

    let actualKeys = Object.keys(actual)
    let templateKeys = Object.keys(template)

    let keysToRemove = []

    actualKeys.forEach(k => {
        // check if its been removed in the template
        if (!templateKeys.includes(k)) {
            keysToRemove.push(k)
            return
        }

        let actualValue = actual[k]
        let templateValue = template[k]

        // update value to match the template
        // if its an object, otherwise just leave
        // undmodified
        if (typeof actualValue == 'object' && typeof templateValue == 'object') {
            changed ||= updateConfigSchema(templateValue, actualValue)
        }

        // remove from template keys because it has been handled
        removeFromArray(templateKeys, k)
    })

    // delete removed keys
    if (keysToRemove.length != 0) {
        changed = true
        keysToRemove.forEach(k => actual[k] = undefined)
    }

    // insert remaining non-covered template keys into the object
    if (templateKeys.length != 0) {
        changed = true
        templateKeys.forEach(k => {
            actual[k] = template[k]
        })
    }

    return changed
}

/** Stores information about a config file */
export class ConfigInfo {

}

@autoRegister()
export class ConfigService extends BotService {

}