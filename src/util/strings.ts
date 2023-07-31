import { getid } from "./debug"
import { completedPromise } from "./future"
import { logtrace } from "./logging"

export const EOS: string = "\uFFFF"
export const UNTIL_SPACE: (c: string) => boolean = c => c != ' '
export const UNTIL_NEWLN: (c: string) => boolean = c => c != '\n'

/** Truncates the given string to a safe length and appends the end */
export function truncate(str: string, maxLen: number, end: string = "..."): string {
    if (str.length <= maxLen) {
        return str
    }

    let rs = str.substring(0, maxLen - end.length)
    rs += end
    return rs
}

// Stringifies an object value
function stringifyObject(value: object, depth: number): string {
    // check for array
    if (Object.getPrototypeOf(value) == Array.prototype) {
        return stringifyArray(value as any[], depth)
    }

    if (depth == 0) {
        return "...OBJECT..."
    }

    let str = ""
    if (value["constructor"])
        str += value["constructor"]?.name
    str += "{ "
    let i = 0
    Object.entries(value).forEach(e => {
        if (i != 0)
            str += ", "
        str += e[0] + ": " + string0(e[1], depth - 1)
        i += 1
    })
    
    return str + " }"
}

// Stringifies an array value
function stringifyArray(value: any[], depth: number): string {
    if (depth == 0) {
        return "...ARRAY(" + value.length + ")..."
    }

    let str = "[ "
    for (let i = 0; i < value.length; i++) {
        if (i != 0) str += ", "
        str += string0(value[i], depth - 1)
    }

    return str + " ]"
}

// Stringifies a value of any type
function string0(value: any, depth: number): string {
    if (typeof value == 'undefined') return "undefined"
    if (value == null) return "null"

    if (value["asString"])
        return value.asString()

    if (typeof value == 'object') return stringifyObject(value, depth)

    return value.toString() // Use TS toString
}

/** Get a sensible string representation for the given value */
export function stringify(value: any): string {
    return string0(value, 5)
}

/** Check whether the given char is whitespace,
 *  This will only work with one char */
export function isCharWhitespace(char: string): boolean {
    return char == ' ' || char == '\t' || char == '\n' || char == '\r'
}

export type StringifyOptions = {
    disableFormatting?: boolean
    floatDecimals?: number
}

/** Create a custom stringifier */
export function stringifier(options: StringifyOptions = { }): (v: any) => string {
    const format: (s: any) => string = options.disableFormatting ?
        (s) => '' :
        (s) => '\x1b[' + s + "m"
    const reset = format(0)
    const num2str: (n: number) => string = options.floatDecimals == undefined ?
        (n) => n.toString() :
        (n) => n.toFixed(options.floatDecimals)

    return function(v) {
        let str: string
        if (typeof v == 'undefined') {
            str = format(31) + 'undefined' + reset
        } else if (v == null) {
            str = format(31) + 'null' + reset
        } else if (typeof v == 'number') {
            str = format(91) + num2str(v) + reset
        } else {
            str = format(91) + v.toString() + reset
        }
    
        return str
    }
}

/** Strip all ANSI colors from the given string */
export function stripANSIColor(str: string): string {
    return str.replaceAll(new RegExp("\x1b\\[[a-e0-9]+m", "g"), '')
}

/** Create a table-like multiline string representing the given array */
export function stringTable<T>(arr: T[], columnNames: string[], columnMapper: (v: T) => any[], stringifier0: (v: any) => string = stringifier({ floatDecimals: 2 })): string {
    // calculate row data
    let columnWidths = new Array(columnNames.length).fill(0)
    let rowDataStr: string[][] = []
    arr.forEach(elem => {
        let data = columnMapper(elem)
        let dataStr = data.map(elem => stringifier0(elem))
        rowDataStr.push(dataStr)

        for (let col = 0; col < columnWidths.length; col++) {
            columnWidths[col] = Math.max(dataStr[col].length, columnWidths[col])
        }
    })

    let str = ""
    rowDataStr.forEach(data => {
        if (str.length != 0)
            str += '\n'

        for (let col = 0; col < columnWidths.length; col++) {
            if (columnNames[col]) str += columnNames[col] + ": "
            str += data[col] + " ".repeat(columnWidths[col] - data[col].length)
            str += " "
        }
    })

    return str
}

/** Stringify with colors */
export const stringifyPretty = stringifier()

/** Represents a location in a string */
export class StringLoc {
    reader: StringReader // The string reader
    start: number        // The start index (inclusive)
    end: number          // The end index (inclusive)

    constructor(reader: StringReader, start: number, end: number) {
        this.reader = reader
        this.start = start
        this.end = end
    }

    // Stringify Method
    asString(): string {
        return this.start + ":" + this.end
    }
}

/** Epoch time to sec ms apostrophy (sSmsMS) */
export function epochTimeToSMS(time: number) {
    let sec = Math.floor(time / 1000)
    let ms  = time % 1000
    return sec + "s" + ms + "ms"
}

/** An error while parsing a string */
export class ParseError extends Error {
    text: string         // The error message
    loc: StringLoc       // The location where the error happened

    constructor(text: string, loc: StringLoc = undefined) {
        super()
        this.name = "ParseError"

        this.text = text
        this.loc = loc

        // construct the message
        this.message = this.text + (this.loc ? " @ " + stringify(this.loc) : "") 
    }
}

/** Utility for building strings */
export class StringBuilder {
    arr: string[] = [] // The array of strings, not necessarily characters only

    /** Append the given object to the string */
    append(v: any): this {
        this.arr.push(stringify(v))
        return this
    }

    /** Convert the array to an array of characters */
    chars(): string[] {
        let out: string[] = []
        this.arr.forEach(s => {
            for (let i = 0; i < s.length; i++) {
                out.push(s.at(i))
            }
        })

        return out
    }

    /** Convert this string builder to one string */
    string(): string {
        return this.arr.join("")
    }
}

/** Utility for parsing strings */
export class StringReader {
    str: string   // The current string
    idx: number   // The current index 
    len: number   // The cached string len
    ist: number[] // Index stack

    constructor(str: string) {
        this.idx = 0
        this.str = str
        this.len = str.length
        this.ist = []
    }

    /* ----- Basic Methods ----- */

    /** Get the character in the string at idx */
    at(idx: number): string {
        if (idx < 0)
            return this.at(this.str.length + idx)
        
        // check bounds for eof
        if (idx < 0 || idx >= this.len)
            return EOS

        return this.str.at(idx)
    }

    current(): string {
        return this.at(this.idx)
    }
    
    /** Get the char at the index with currIdx + offset */
    off(offset: number): string {
        return this.at(this.idx + offset)
    }

    /** Move the cursor by the given offset and return the final char */
    move(a: number = 1): string {
        // check index bounds
        if (this.idx == -1 || this.idx == this.len)
            return EOS

        this.idx += a
        return this.current()
    }

    /** Same as move(a) */
    next(a: number = 1): string {
        return this.move(a)
    }
    
    /** Same as move(-a) */
    back(a: number = 1): string {
        return this.move(-a)
    }

    /**
     * Check whether the given string is next.
     * @param s The string to check
     */
    peekCheckString(s: string): boolean {
        let i = 0
        while (i < s.length) {
            if (s.at(i) != this.at(this.idx + i))
                return false
            i++
        }

        return true
    }
 
    /** Expect the given string, throw if absent otherwise skip over it */
    expect(c: string) {
        let si = this.idx
        for (let i = 0; i < c.length; i++) {
            if (this.current() != c.at(i)) {
                throw new ParseError("Expected `" + c + "`", new StringLoc(this, si, this.idx))
            }

            this.next()
        }
    }

    /**
     * @param pred The predicate
     * @param skip The skip predicate
     * @returns The collected string
     */
    collect(pred: (c: string) => boolean = _ => true, skip: (c: string) => boolean = _ => false): string {
        let b: StringBuilder = new StringBuilder()
        let c: string
        while ((c = this.current()) != EOS) {
            // check if it should skip
            if (skip(c)) {
                this.next()
                continue
            }

            // check whether were still in the string
            if (!pred(c)) {
                break
            }
            
            b.append(c)
            this.next()
        }

        return b.string()
    }

    /** Skips all whitespace until the next character */
    skipWhitespace() {
        let c = this.current()
        while (isCharWhitespace(c)) {
            c = this.next()
        }
    }

    pushIndex() { 
        this.ist.push(this.idx) 
    }

    restore() {
        this.idx = this.ist.pop()
    }
}

/** Represents a result of a parse */
export class ParseResult<T> {
    static fromPromise<T>(promise: Promise<ParseResult<T>>): ParseResult<T> {
        let result = new ParseResult(undefined, undefined, undefined, undefined)
        result.promise = promise.then(res => {
            result.error = res.error
            result.uncaughtError = res.uncaughtError
            result.value = res.value
            return result
        })

        return result
    }

    static with<T>(value: T) {
        return new ParseResult(value, undefined, undefined, undefined)
    }

    value: T                // The result of the parsing, present if successful
    error: ParseError       // The created parse error if it failed
    uncaughtError?: Error   // The uncaught error if it failed
    promise?: Promise<this> // The promise for the data, null if sync
    completed: boolean      // Whether this result was completed

    constructor(value: T, error: ParseError, uncaughtError: Error, promise: Promise<ParseResult<T>>) {
        this.value = value
        this.error = error
        this.uncaughtError = uncaughtError
        this.promise = promise as Promise<this>

        if (this.promise) {
            this.completed = false
            promise.then(() => this.completed = true)
        } else this.completed = true
    }

    public get isSync() {
        return !this.promise
    }

    public await(): Promise<this> {
        return this.promise ? this.promise : completedPromise(this)
    }

    public use<R>(func: (v: this) => Promise<ParseResult<R>> | ParseResult<R>): Promise<ParseResult<R>> {
        let promise = this.promise ? 
            this.promise.then(v => v.error ? v as unknown as ParseResult<R> : func(v)) :
            (this.error ? completedPromise(this as unknown as ParseResult<R>) : completedPromise(func(this)).then(r => r))
        return promise
    }
}

/** The parse context */
export abstract class ParseContext {
    public static simple(reader: StringReader): ParseContext {
        return new class extends ParseContext {
            public getReader(): StringReader {
                return reader
            }
        }
    }

    /** Get the string reader */
    public abstract getReader(): StringReader

    /** Creates a new completed parse result */
    public completedParse<T>(value: T): ParseResult<T> {
        return new ParseResult(value, undefined, undefined, undefined)
    }

    /** Creates a new failed parse result */
    public failedParse(error: ParseError): ParseResult<any> {
        return new ParseResult(undefined, error, undefined, undefined)
    }

    /** Parse a value in this context using the given parser */
    public parse<T>(parser: Parser<T>): ParseResult<T> {
        try {
            return parser.parse(this)
        } catch (e) {
            if (e instanceof ParseError)
                return this.failedParse(e)
            return new ParseResult(undefined, undefined, e, undefined)
        }
    }
}

/** Parses a value of type T from a string */
export interface Parser<T> {
    /**
     * Parse a value from the given string reader and return it
     * @param reader The string reader
     */
    parse(ctx: ParseContext): ParseResult<T>

    /**
     * Stringify the given value and return it
     * @param value The value to stringify
     */
    emit(value: T): string
}

/* --------- Standard Parsers --------- */
export function newSyncParser<T, C extends ParseContext = ParseContext>(p: (ctx: C) => ParseResult<T>, e: (value: T) => string = v => stringify(v)) {
    return new class implements Parser<T> {
        parse(ctx: ParseContext): ParseResult<T> {
            return p(ctx as C)
        }

        emit(value: T): string {
            return e(value)
        }
    }
}

export function newAsyncParser<T, C extends ParseContext = ParseContext>(p: (ctx: C) => Promise<ParseResult<T>> | ParseResult<T>, e: (value: T) => string = v => stringify(v)) {
    return new class implements Parser<T> {
        parse(ctx: ParseContext): ParseResult<T> {
            let res = p(ctx as C)
            if (res instanceof Promise) {
                return ParseResult.fromPromise(res)
            }

            return res
        }

        emit(value: T): string {
            return e(value)
        }
    }
}

/** Check if the given char is a base 10 digit */
export function isBase10Digit(c: string): boolean {
    return c >= '0' && c <= '9'
}

/** Standard primitive parsers */
export class Parsers {
    constructor() { }

    public static readonly String: Parser<string> = newSyncParser<string>(ctx => {
        let reader = ctx.getReader()

        if (reader.current() == '"' || reader.current() == "'") {
            // collect quotes string
            let quote = reader.current()
            let str = reader.collect(c => c != quote)
            reader.next() // skip end quote

            return ctx.completedParse(str)
        }
        
        // collect unquoted string
        return ctx.completedParse(reader.collect(c => c != ' '))
    })

    public static readonly GreedyString: Parser<string> = newSyncParser<string>(ctx => ctx.completedParse(ctx.getReader().collect()))

    public static readonly Number: Parser<number> = newSyncParser<number>(ctx => ctx.completedParse(parseFloat(ctx.getReader().collect(c => (c >= '0' && c <= '9') || c == '.' || c == '_'))))

    public static List<E>(elem: Parser<E>): Parser<Array<E>> {
        return newSyncParser<Array<E>>(ctx => {
            let r = ctx.getReader()
            
            let isb = r.current() == '['
            if (isb)
                r.next()
            r.skipWhitespace()
            if (r.current() == ']') {
                return ctx.completedParse([])
            }
            
            // parse elements
            // we know there is at least one element
            // in the list now so we can just parse it 
            // directly
            let list = [ elem.parse(ctx) ]
            r.skipWhitespace()
            while (r.current() == ',') {
                r.next()
                r.skipWhitespace()

                list.push(elem.parse(ctx))
                r.skipWhitespace()
            }

            r.skipWhitespace()
            if (isb)
                r.expect("]")

            return ctx.completedParse(list)
        }, v => {
            let b: StringBuilder = new StringBuilder()
            b.append("[ ")
            let l = v.length
            for (let i = 0; i < l; i++) {
                if (i != 0) b.append(", ")
                b.append( elem.emit(v.at(i)) )
            }

            b.append(" ]")
            return b.string()
        })
    }

    static readonly UNIT2MS_MAP: Map<string, number> = new Map()
        .set("ms", 1)
        .set("s", 1000)
        .set("m", 60 * 1000)
        .set("h", 60 * 60 * 1000)
        .set("d", 24 * 60 * 60 * 1000)
        .set("M", 30 * 24 * 60 * 60 * 1000)
        .set("y", 365 * 24 * 60 * 60 * 1000)

    public static readonly Duration: Parser<number> = newSyncParser<number>(ctx => {
        let reader = ctx.getReader()
        let total = 0

        // parse time elemens
        while (isBase10Digit(reader.current())) {
            let num = (this.Number.parse(ctx) as ParseResult<number>).value
            if (num == 0 || Number.isNaN(num)) {
                return ctx.completedParse(0)
            }

            let ci = reader.idx
            let unit = reader.collect(c => !isBase10Digit(c) && c != ' ')
            let ms = this.UNIT2MS_MAP.get(unit)
            if (!ms) {
                return ctx.failedParse(new ParseError("No time unit by name `" + unit + "`", new StringLoc(reader, ci, reader.idx)))
            }

            total += num * ms
        }

        return ctx.completedParse(total)
    })
}