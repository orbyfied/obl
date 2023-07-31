import { StringBuilder, stringify } from "./strings"

/*
    Logging Utilities
*/

const path = require('path')

const cwd = process.cwd().replace("\\", "/")
const cwdBuild = path.join(cwd, "build").replace("\\", "/")

/** Get the fixed stack trace split by newlines */
export function getStackTraceSplit(stack: string): string[]  {
    let trace = stack.split("\n")
        .slice(1)
        .map(s => s.replace("\\", "/")
            .replace(cwdBuild, "./build/")
            .replace(cwd, "..")
        )

    // truncate TS internals
    let i
    for (i = trace.length; i >= 0; i--) {
        let elem = trace[i]
        if (!elem) continue

        // check for Module._compile
        break
        // if (elem.trimStart().startsWith("at Module._compile")) {
        //     break
        // }
    }

    let oldLen = trace.length
    trace = trace.slice(0, i + 1)
    trace.push("    -  " + (oldLen - i - 1) + " internal lines")

    return trace
}

/**
 * Basic Logger
 */
export class Logger {

    label: string               // The logger label
    stacktraces: boolean = true // Whether it should print error stack traces

    constructor(label: string) {
        this.label = label;
    }

    /**
     * Logs the given formattable message to the console.
     * 
     * @param msg The message format.
     * @param level The log level string.
     * @param args The formatting values array.
     */
    log(msg: any, level: string, args: any[]) {
        let errors: Error[] = []

        // format the placeholders
        let msgStr: string = stringify(msg)
        for (let i = 0; i < args.length; i++) {
            let elem = args[i]
            msgStr = msgStr.replace("{" + i + "}", "\x1b[91m" + elem?.toString() + "\x1b[97m");

            if (elem instanceof Error) {
                errors.push(elem)
            }
        }

        // create log format
        let dateString = new Date().toLocaleTimeString();
        let logPrefix = "[\x1b[96m" + this.label + "\x1b[0m\x1b[90m/" + level + "\x1b[0m]"
        let fullLogPrefix = "\x1b[90m" + new Date().toLocaleTimeString() + "\x1b[0m " + logPrefix
        let spacedLogPrefix = " ".repeat(dateString.length + 1) + logPrefix

        // log the formatted message
        console.log(fullLogPrefix + " \x1b[97m" + msgStr + "\x1b[0m");
        
        if (this.stacktraces) {
            // log error stack traces
            errors.forEach(e => {
                let isCause = false
                while (e) {
                    console.log(spacedLogPrefix + " \x1b[37m" + (isCause ? "Caused By: " : "") + e.name + ": " + e.message + "\x1b[0m")
                    getStackTraceSplit(e.stack)
                        .map(s => spacedLogPrefix + " \x1b[90m" + s + "\x1b[0m")
                        .forEach(s => console.log(s))

                    // get cause
                    e = e.cause as Error
                    isCause = true
                }
            })   
        }
    }

    info(msg: any, ...args: any[])  { this.log(msg, "\x1b[46mINFO",  args); }
    debug(msg: any, ...args: any[]) { this.log(msg, "\x1b[44mDEBUG", args); }
    warn(msg: any, ...args: any[])  { this.log(msg, "\x1b[43mWARN",  args); }
    error(msg: any, ...args: any[]) { this.log(msg, "\x1b[41mERROR", args); }
    
}

/* Error Handling */
const logger: Logger = new Logger("Process")
process.on('uncaughtException', (err) => { logger.error("External error: {0} \x1b[41m\x1b[31mUNCAUGHT\x1b[0m", err) });

/** Basic trace logging without a logger */
export function logtrace(...msgArr: any[]) {
    let msg = new StringBuilder()
    msgArr.forEach(m => {
        if (typeof m != 'string') msg.append("\x1b[91m").append(m).append("\x1b[0m")
        else msg.append(m)
        msg.append(" ")
    })

    let stack = new Error().stack
    let sts = getStackTraceSplit(stack)
    console.log("\x1b[46mTRACE:\x1b[0m " + msg.string())
    sts.forEach(s => console.log("\x1b[90m" + s))
}