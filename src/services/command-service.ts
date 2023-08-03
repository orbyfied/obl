import { BaseMessageOptions, Client, EmbedBuilder, Events, GatewayIntentBits, Guild, GuildChannel, GuildMember, Message, MessageCreateOptions, MessagePayload, MessageReplyOptions, PermissionResolvable, PermissionsBitField, TextBasedChannel, TextChannel, User } from "discord.js";
import { BotService, DependencyType, ServiceManager, autoRegister, dependency, discordEventHandler, providedBy, provides } from "../services";
import { Parser, StringReader, Parsers as ParsersBase, stringify, StringLoc, ParseError, EOS, ParseContext, epochTimeToSMS, UNTIL_NEWLN, StringBuilder, ParseResult, newSyncParser, newAsyncParser } from "../util/strings";
import { Optional } from "../util/optional";
import { Logger } from "util/logging";
import { PermissionManager, Permit } from "./permission-service";
import { completedPromise } from "../util/future";

/** Options for sending the result message */
export type ResultMessageOptions = { noReply?: boolean, editMessage?: string | Message, deleteUsage?: boolean, deleteAfter?: number }

/** The command result/feedback */
export abstract class CommandResult {
    public readonly ctx: CommandContext    // The command context
    msgOptions: ResultMessageOptions = { } // The message options

    constructor(ctx: CommandContext) {
        this.ctx = ctx
    }

    public messageOptions(o: ResultMessageOptions): this {
        this.msgOptions = o
        return this
    }

    /** Get the errors from this result */
    abstract get errors(): Error[]

    /** Get whether the errors should be traced */
    abstract get trace(): boolean

    /** Whether the operation was succesful */
    abstract get success(): boolean

    /** Get the message */
    abstract get errorMessage(): string

    /** Create the message payload for feedback, null for no message */
    abstract buildMessage(): BaseMessageOptions

    /** Unwrap this result into all subresults */
    public unwrap(): CommandResult[] {
        return [this]
    }

    /** Trace all errors */
    public traceErrors() {
        logger.error("Error occurred while executing command {0}: {1}",
                this.errorMessage,
                this.ctx.command.prefix + this.ctx.command.name, ...this.errors)
    }

    /** Handle this result the default way */
    public handleDefault() {
        // send result message
        let payload = this.buildMessage()
        if (payload) {
            let edit = this.msgOptions.editMessage
            new Promise<Message>(resolve => {
                let msg: string | Message = this.msgOptions.editMessage
                if (edit && msg) {
                    if (typeof msg == 'string')
                        msg = this.ctx.channel.messages.cache.get(msg)
                    resolve(msg.edit(payload))
                } else if (this.msgOptions.noReply) {
                    resolve(this.ctx.channel.send(payload))
                } else {
                    resolve(this.ctx.message.reply(payload))
                }
            }).then(msg => {
                // delete messages
                if (this.msgOptions.deleteAfter) {
                    setTimeout(() => {
                        if (this.msgOptions.deleteUsage)
                            this.ctx.message.delete()
                        msg.delete()
                    }, this.msgOptions.deleteAfter)
                }
            })
        }

        // trace errors if needed
        this.unwrap().forEach(r => r.trace ? r.traceErrors() : { })
    }
}

/** A generally successful result */
export abstract class SuccessLikeResult extends CommandResult {
    get errors(): Error[] {
        return []
    }

    get trace(): boolean {
        return false
    }

    get success(): boolean {
        return true
    }

    get errorMessage(): string {
        return undefined
    }
}

// The command result for when there is no executor found
export function noExecutor(ctx: CommandContext): CommandResult {
    return new class extends SuccessLikeResult {
        constructor() { super(ctx) }

        buildMessage(): MessageCreateOptions {
            return null
        }
    }
}

/** Indicates a successful result */
export class SuccessResult extends SuccessLikeResult {
    message: string | MessageCreateOptions // The success message

    constructor(ctx: CommandContext, message: string | MessageCreateOptions) {
        super(ctx)
        this.message = message
    }

    public buildMessage(): MessageCreateOptions {
        // return null if no message
        if (!this.message) {
            return undefined
        }

        // return message create options directly
        if (typeof this.message != 'string') {
            return this.message
        }

        // build default embed
        let desc = "`✅` "
        let split = this.message.split("\n")
        if (split.length == 1) {
            desc += split[0]
        } else {
            desc += '\n' + split[1]
        }

        return { embeds: [
            new EmbedBuilder()
            .setColor("#16c60c")
            .setDescription(desc)
        ]}
    }
}

export function success(ctx: CommandContext, msg: string | MessageCreateOptions): SuccessResult {
    return new SuccessResult(ctx, msg)   
}

export class FailError extends Error { }

/** Represents a tracable error */
export abstract class FailLikeResult extends CommandResult {
    // Build the description of the error embed
    abstract buildDesc(): string

    get success(): boolean {
        return false
    }

    buildMessage(): MessageCreateOptions {
        return { embeds: [
            new EmbedBuilder()
            .setColor("#d93415")
            .setDescription(this.buildDesc())
        ]}
    }
}

/** Signals something went wrong but not uncaught */
export class FailResult extends FailLikeResult {
    message: string // The error message

    constructor(ctx: CommandContext, message: string) {
        super(ctx)
        this.message = message
    }

    get errors(): Error[] {
        return []
    }

    get trace(): boolean {
        return false
    }

    get errorMessage(): string {
        return undefined
    }

    buildDesc(): string {
        let desc = "`❌` "
        let split = this.message.split("\n")
        if (split.length == 1) {
            desc += split[0]
        } else {
            desc += '\n' + split[1]
        }

        return desc
    }
}

export function failed(ctx: CommandContext, msg: string): FailResult {
    return new FailResult(ctx, msg)
}

/** Signals that an assertion failed */
export class AssertionFailedResult extends FailResult {
    assertion: CommandAssertion // The assertion which failed

    constructor(ctx: CommandContext, msg: string, assertion: CommandAssertion) {
        super(ctx, msg)
        this.assertion = assertion
    }
}

/** Signals parsing errors */
export class ParseErrorsResult extends FailResult {
    constructor(ctx: CommandContext, error: ParseError) {
        super(ctx, "Parse Error: " + error.message)
        this.error = error
    }

    error: ParseError // The parsing error

    get errors(): Error[] {
        return [this.error]
    }
}

export class MutliFailResult extends FailResult {
    constructor(ctx: CommandContext, results: FailLikeResult[]) {
        super(ctx, 'Multiple Errors Occurred')
        this._results = results
        results.filter(r => r.errors && r.errors.length > 0).forEach(r => this.errors.push(...r.errors))
    }

    _errors: Error[] = []      // All the errors
    _results: FailLikeResult[] // The failed command results

    public unwrap(): CommandResult[] {
        return this._results.flatMap(r => r.unwrap())
    }

    get errors(): Error[] {
        return this._errors
    }

    get trace(): boolean {
        return false
    }

    buildDesc(): string {
        if (this._results.length != 1) {
            return '**`❌ Multiple Errors`**\n' + this._results
                .map(r => r.buildDesc())
                .join('\n')
        } else {
            return this._results[0].buildDesc()
        }
    }
}

/** Signals an uncaught error */
export class UncaughtErrorResult extends FailLikeResult {
    error: Error    // The error which occurred
    message: string // The error message to display

    constructor(ctx: CommandContext, error: Error, msg: string) {
        super(ctx)
        this.error = error
        this.message = msg
    }

    get errors(): Error[] {
        return [this.error]
    }

    get trace(): boolean {
        return true
    }

    get success(): boolean {
        return false
    }

    get errorMessage(): string {
        return this.message
    }

    buildDesc(): string {
        let desc = "`❌` "
        let split = this.message.split("\n")
        if (split.length == 1) {
            desc += split[0]
        } else {
            desc += '\n' + split[1]
        }

        return desc
    }
}

/** The cause/type of a command error */
export enum CommandErrorType {
    SYSTEM       = "SYSTEM",       // An error in the command system
    EXECUTOR     = "EXECUTOR",     // An error in the execuctor of the command
    PARSE        = "PARSE",        // A parsing error occurred
    UNKNOWN_FLAG = "UNKNOWN_FLAG", // Unknown flag
    UNKNOWN_NODE = "UNKNOWN_NODE", // Unknown subcommand/node
    UNKNOWN_CMD  = "UNKNOWN_CMD",  // Unknown base command
    ASSERT_FAIL  = "ASSERT_FAIL"   // Assertion/predicate failed
}

function commandArgumentRequiredOptional<T>(o: Optional<T>, name: string): Optional<T> {
    o.createAbsentValueError = () => new FailError("`" + name + "` is a required argument")
    return o
}

/** An error in a command */
export class CommandError extends Error {
    ctx:   CommandContext
    loc:   StringLoc
    msg:   string
    type:  CommandErrorType
    trace: boolean

    constructor(ctx: CommandContext, msg: string, type: CommandErrorType, loc: StringLoc = undefined) {
        super()
        this.name = "CommandError"

        this.ctx = ctx
        this.loc = loc
        this.msg = msg
        this.type = type

        this.message = msg + (loc ? " @ " + stringify(loc) : "")
    }

    public setTrace(): CommandError {
        this.trace = true
        return this
    }

    public withCause(cause: Error): CommandError {
        this.cause = cause
        return this
    }
}

export type MultiParseResult = { context: CommandContext, result: CommandResult }

/** The command execution context */
export class CommandContext extends ParseContext {
    constructor() {
        super()
        this.nodeStack = []
    }

    reader: StringReader                                   // The command string reader
    command: CommandNode                                   // The base command node
    nodeStack: CommandNode[]                               // The node traversal stack, top is current node
    promise: Promise<CommandResult>                        // The command result promise               

    registeredFlags: Map<string, CommandFlag> = new Map()  // All registered flags
    registeredArgs: Map<string, CommandNode> = new Map()   // All registered arguments

    flagResults: Map<string, ParseResult<any>> = new Map() // The parsed/queried flag values
    argResults: Map<string, ParseResult<any>> = new Map()  // The parsed/queried argument values
    awaitableResults: Promise<ParseResult<any>>[] = []     // The list of awaitable promises

    client: Client                                         // The Discord client
    message: Message                                       // The Discord message
    guild: Optional<Guild>                                 // The Discord guild if present
    author: User                                           // The Discord author of the message
    member: Optional<GuildMember>                          // The Discord author as a member of the guild
    channel: TextBasedChannel                              // The Discord channel the message was sent in

    setMessage(message: Message) {
        this.client = message.client

        this.message = message
        this.author = message.author
        this.channel = message.channel

        this.guild = Optional.define(message.guild)
        this.member = Optional.define(message.member)
    }

    /** Get the value of the argument or the default set */
    arg<T>(name: string): Optional<T> {
        // check for set value
        let value = this.argResults.get(name)
        if (value != undefined) {
            return Optional.present(value.value)
        }

        let arg = this.registeredArgs.get(name)
        if (!arg) {
            // argument does not exist
            return commandArgumentRequiredOptional(Optional.empty(), name)
        }
        
        // if possible,
        // get and cache default value
        // then return it
        if (arg.defaultSupplier == undefined || !arg.defaultSupplier)
            return commandArgumentRequiredOptional(Optional.empty(), name)
        this.argResults.set(name, value = this.completedParse(arg.defaultSupplier(this)))
        return Optional.present(value.value)
    }

    /** Get the value of the flag or the default set */
    flag<T>(name: string): Optional<T> {
        // check for set value
        let value = this.flagResults.get(name)
        if (value != undefined) {
            return Optional.present(value.value)
        }

        let flag = this.registeredFlags.get(name)
        if (!flag) {
            // argument does not exist
            return commandArgumentRequiredOptional(Optional.empty(), name)
        }
        
        // if possible,
        // get and cache default value
        // then return it
        if (flag.defaultSupplier == undefined || !flag.defaultSupplier)
            return commandArgumentRequiredOptional(Optional.empty(), name)
        this.flagResults.set(name, value = this.completedParse(flag.defaultSupplier(this)))
        return Optional.present(value.value)
    }

    /** Set the value of an argument */
    public argResult(name: string, v: ParseResult<any>): this {
        // register result
        this.argResults.set(name, v)

        // check if awaitable
        if (v.promise != undefined) {
            this.awaitableResults.push(v.promise)
        }

        return this
    }

    /** Set the value of a flag */
    public flagResult(name: string, v: ParseResult<any>): this {
        // register result
        this.flagResults.set(name, v)

        // check if awaitable
        if (v.promise != undefined) {
            this.awaitableResults.push(v.promise)
        }

        return this
    }

    /** Await all registered promises */
    public awaitPromises(): Promise<MultiParseResult> {
        return Promise.all<ParseResult<any>>(this.awaitableResults).then((results: ParseResult<any>[]) => {
            // accumulate failed results
            let failed: ParseResult<any>[] = results.filter(r => r.error)
            if (failed.length > 0) {
                let results = failed.map(r => toErrorResult(this, r))
                return { context: this, result: new MutliFailResult(this, results) }
            }

            // return context
            return { context: this, result: undefined }
        })
    }
    
    /** Creates a success result */
    public success(msg: string | MessageCreateOptions = null): CommandResult {
        return success(this, msg)
    }

    /** Creates a fail result */
    public fail(msg: string): CommandResult {
        return failed(this, msg)
    }

    public override getReader(): StringReader {
        return this.reader
    }
}

/** Represents a flag a node can register to the command tree */
// todo: implement enum shit like -a = Enum.A, -b = Enum.B at same value
export class CommandFlag {
    name: string                                  // The name of the flag
    aliases: string[]                             // The flag aliases
    type: Parser<any>                             // The argument type of the flag
    defaultSupplier: (ctx: CommandContext) => any // The default value supplier (flags are always optional)
    isSwitch: boolean                             // Whether the flag is a switch
}

export function flag(name: string, type: Parser<any>, def: any = undefined, aliases: string[] = []) {
    let flag: CommandFlag = new CommandFlag()
    flag.name = name
    flag.type = type
    if (def) flag.defaultSupplier = () => def
    flag.aliases = aliases
    flag.isSwitch = false
    return flag
}

export function flagSwitch(name: string, def: boolean, aliases: string[] = []) {
    let flag: CommandFlag = new CommandFlag()
    flag.name = name
    if (def) flag.defaultSupplier = () => def
    flag.aliases = aliases
    flag.isSwitch = true
    return flag
}

/** The result of an assertion */
export class CommandAssertionResult {
    public static readonly SUCCESS = new CommandAssertionResult(false, undefined, undefined)

    public static fail(message: string, error: any = null) {
        return new CommandAssertionResult(true, error, message)
    }

    failed: boolean // Whether the assertion failed
    error: any      // The error identifier, can be any object
    message: string // The error message

    constructor(failed: boolean, error: any, message: string) {
        this.failed = failed
        this.error = error
        this.message = message
    }
}

/** A command assertion */
export interface CommandAssertion {
    /**
     * Test this assertion in the given context.
     * @param ctx The command context
     */
    test(ctx: CommandContext): CommandAssertionResult
}

/** Represents a node in the command tree */
export class CommandNode {
    name: string                                              // The name of this node
    aliases: string[]                                         // The aliases
    executor: (ctx: CommandContext) => Promise<CommandResult> // The executor for this command node
    literal: boolean                                          // Whether this node is a literal
    argumentType: Parser<any>                                 // The argument type for this node
    optional: boolean                                         // Whether this argument is optional
    defaultSupplier: (ctx: CommandContext) => any             // Supplies the default value if the arg is optional
    children: CommandNode[]                                   // The child nodes of this command node
    flags: CommandFlag[]                                      // The flags this node registers
    meta: any                                                 // Customizable metadata
    assertions: CommandAssertion[]                            // The list of assertions for this node
    prefix: string                                            // The prefix (only for base commands)

    constructor() {
        this.flags = []
        this.children = []
        this.aliases = []
        this.assertions = []
        this.meta = {}
    }
}

/** A builder for a command node */
export class CommandBuilder {
    protected constructor() { }

    /** Creates a new command builder for a literal node */
    public static literal(name: string): CommandBuilder {
        let builder = new CommandBuilder()
        builder.node.name = name
        builder.node.literal = true
        return builder
    }

    /** Creates a new command builder for an argument node */
    public static argument(name: string, type: Parser<any>): CommandBuilder {
        let builder = new CommandBuilder()
        builder.node.name = name
        builder.node.literal = false
        builder.node.argumentType = type
        builder.node.optional = false
        return builder
    }

    private node: CommandNode = new CommandNode() // The command node being built

    /**
     * Build the command node from this builder
     */
    public toNode(): CommandNode {
        return this.node
    }

    /* ---- Methods ---- */

    public then(node: CommandNode | CommandBuilder): CommandBuilder {
        this.node.children.push(node instanceof CommandBuilder ? node.toNode() : node)
        return this
    }

    public prefix(prefix: string): CommandBuilder {
        this.node.prefix = prefix
        return this
    }

    public aliases(...alias: string[]): CommandBuilder {
        this.node.aliases.push(...alias)
        return this
    }
 
    public executes(executor: (ctx: CommandContext) => CommandResult | Promise<CommandResult>): CommandBuilder {
        this.node.executor = ctx => new Promise(resolve => { 
            try {
                resolve(executor(ctx))
            } catch (e) {
                if (e instanceof FailError) {
                    return resolve(failed(ctx, e.message))
                }

                // return error occurred
                return resolve(new UncaughtErrorResult(ctx, e, "Error in executor: `" + e + "`"))
            }
        })

        return this
    }

    public optional(defSupplier: ((ctx: CommandContext) => void) | any = _ => undefined): CommandBuilder {
        if (typeof defSupplier != 'function') {
            defSupplier = _ => defSupplier
        }

        this.node.optional = true
        this.node.defaultSupplier = defSupplier
        return this
    }

    public flag(flag: CommandFlag): CommandBuilder {
        this.node.flags.push(flag)
        return this
    }

    public asserts(assert: CommandAssertion): CommandBuilder {
        this.node.assertions.push(assert)
        return this
    }

    public permissions(...perms: string[]): CommandBuilder {
        return this.asserts(CommandAssertions.Permissions(...perms))
    }
}

export const literal = CommandBuilder.literal
export const argument = CommandBuilder.argument

function toErrorResult(ctx: CommandContext, res: ParseResult<any>): FailLikeResult {
    if (res.error) return new ParseErrorsResult(ctx, res.error)
    if (res.uncaughtError) return new UncaughtErrorResult(ctx, res.uncaughtError, "Uncaught error while parsing")
    return null
}

/** The command dispatcher */
@providedBy("CommandService", DependencyType.SERVICE)
export class CommandDispatcher {
    commandMap: Map<string, CommandNode> = new Map() // All registered prefix + aliases mapped to their respective commands
    commands: CommandNode[] = []                     // A list of all registered commands
    prefixes: string[] = []                          // All registered prefixes
    standardPrefix: string                           // The standard prefix to use
    logCommands: boolean = true                      // Whether it should log command usage

    /** Register the given command node */
    public register(nodeOrBuilder: CommandNode | CommandBuilder) {
        // convert to node
        let node = nodeOrBuilder instanceof CommandBuilder ? nodeOrBuilder.toNode() : nodeOrBuilder
    
        let prefix = node.prefix ? node.prefix : this.standardPrefix
        if (!this.prefixes.includes(prefix))
            this.prefixes.push(prefix)
        node.prefix = prefix
        this.commands.push(node)
        this.commandMap.set(prefix + node.name, node)
        node.aliases.forEach(a => this.commandMap.set(prefix + a, node))
    }

    /** Dispatch the given command context */
    public dispatch(ctx: CommandContext): Promise<CommandResult> {
        try {
            let reader = ctx.reader

            // find command
            reader.pushIndex()
            let commandName = reader.collect(c => c != ' ' && c != '\n').toLowerCase()
            reader.restore()
            ctx.command = this.commandMap.get(commandName)
            if (!ctx.command) {
                return completedPromise(ctx.fail("No command by name `" + commandName + "`"))
            }

            let currentNode = ctx.command                                        // The node we are iterating over
            let executor: (ctx: CommandContext) => Promise<CommandResult> = null // The executor to run at the end

            while (currentNode) {
                if (reader.current() == EOS) {
                    break
                }

                // test node assertions
                for (let a of currentNode.assertions) {
                    let result = a.test(ctx)
                    if (result.failed) {
                        return completedPromise(new AssertionFailedResult(ctx, result.message, a))
                    }
                }

                // parse current node
                if (currentNode.literal) {
                    // just skip over the literal
                    reader.collect(c => c != ' ')
                } else {
                    // parse argument value
                    let res = ctx.parse(currentNode.argumentType)
                    let err = toErrorResult(ctx, res)
                    if (err) return completedPromise(err)
                    ctx.argResult(currentNode.name, res)
                }

                // register set flags
                currentNode.flags.forEach(f => {
                    ctx.registeredFlags.set(f.name, f)
                    f.aliases.forEach(s => ctx.registeredFlags.set(s, f))
                })

                // try and parse flags
                reader.skipWhitespace()
                while (reader.current() == '-') {
                    reader.next()
                    let ci = reader.idx
                    let name = reader.collect(c => c != ' ')
                    let flag = ctx.registeredFlags.get(name)
                    if (!flag) {
                        throw new CommandError(ctx, "No flag by alias `" + name + "`", 
                            CommandErrorType.UNKNOWN_FLAG, new StringLoc(reader, ci, reader.idx - 1))
                    }

                    let value: any 
                    if (flag.isSwitch) {
                        value = ctx.completedParse(true)
                    } else {
                        reader.next()

                        // parse flag value
                        let res = ctx.parse(flag.type)
                        let err = toErrorResult(ctx, res)
                        if (err) return completedPromise(err)
                        value = res
                    }

                    ctx.flagResult(flag.name, value)
                }

                // check for executor
                if (currentNode.executor) {
                    executor = currentNode.executor
                }

                // select next node
                currentNode = this.findNext(ctx, currentNode)
                if (!currentNode && reader.current() != EOS) {
                    let ci = reader.idx
                    let s = reader.collect(c => c != ' ')
                    return completedPromise(ctx.fail("No subcommand by name `" + s + "`"))
                }

                ctx.nodeStack.push(currentNode)
            }

            // run the executor
            // after all awaitables
            // have completed
            if (executor) {
                return ctx.promise = ctx.awaitPromises().then(res => res.result ? res.result : executor(res.context))
            }

            // no executor, dont await shit
            return completedPromise(noExecutor(ctx))
        } catch (e) {
            // throw system error
            return completedPromise(new UncaughtErrorResult(ctx, e, "System Error: `" + e + "`"))
        }
    }

    // Select the next node to be handled
    private findNext(ctx: CommandContext, currentNode: CommandNode): CommandNode {
        let it: CommandNode = null // The selected node

        let reader = ctx.reader
        let children = currentNode.children
        for (let i = 0; i < children.length; i++) {
            let node = children[i]

            // check for literal
            if (node.literal) {
                reader.pushIndex()
                let s = reader.collect(c => c != ' ')
                if (s == node.name) {
                    it = node
                    reader.restore()
                    break
                }

                reader.restore()
            } else {
                if (it == null || !it.literal) {
                    it = node
                }
            }
        }

        reader.skipWhitespace()
        return it
    }

    //
    // Message Create Handler
    //
    async onMessageSent(msg: Message) {
        msg = await msg.fetch()

        // check for prefix
        let startsWith = false
        this.prefixes.forEach(p => {
            startsWith ||= msg.content.startsWith(p)
        })

        if (!startsWith)
            return

        // timing //
        let t1 = Date.now()

        // create command context
        let ctx = new CommandContext()
        ctx.reader = new StringReader(msg.content)
        ctx.setMessage(msg)

        // dispatch command and return
        // any eventual results to the user
        let resultPromise = this.dispatch(ctx)
        resultPromise.then(r => {
            r.handleDefault()

            // timing //
            let t2 = Date.now()
            let t  = t2 - t1

            // logging //
            if (ctx.command && this.logCommands) {
                logger.info("{0} ran command {1} in {2}", 
                    msg.author.username, 
                    ctx.command.prefix + ctx.command.name, 
                    epochTimeToSMS(t))
            }  
        })
    }
}

/* ----------------------------------------------- */

let logger: Logger

@autoRegister()
export class CommandService extends BotService {
    readonly requiredDiscordIntents = [ GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.Guilds ]

    @dependency(PermissionManager)
    permissionManager: PermissionManager

    // The global command dispatcher
    @provides(CommandDispatcher)
    globalDispatcher: CommandDispatcher

    constructor() {
        super()
        logger = this.logger
    }

    onLoad(manager: ServiceManager): void {
        this.globalDispatcher = new CommandDispatcher()
        this.globalDispatcher.standardPrefix = "?"
    }

    @discordEventHandler(Events.MessageCreate)
    private async onMessageSent(msg: Message) {
        return this.globalDispatcher.onMessageSent(msg)
    }
}

export function syncArgumentParser<R>(parser: (ctx: CommandContext) => ParseResult<R>, emitter: (value: R) => string = v => stringify(v)) {
    return newSyncParser<R, CommandContext>(parser, emitter)
}

export function asyncArgumentParser<R>(parser: (ctx: CommandContext) => Promise<ParseResult<R>> | ParseResult<R>, emitter: (value: R) => string = v => stringify(v)) {
    return newAsyncParser<R, CommandContext>(parser, emitter)
}

export class CodeBlock {
    lang: string // The defined language
    text: string // The content of the code block
}

/** More parsers */
export class Parsers extends ParsersBase {
    public static readonly DiscordUser: Parser<User> = asyncArgumentParser(ctx => {
        let ci = ctx.reader.idx
        let str = ctx.reader.collect(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
        let user: User

        // check special strings
        switch (str) {
            case 'me':
            case '.':
                return ctx.completedParse(ctx.author)
        }
        
        // try number user id
        let number = parseInt(str)
        if (!Number.isNaN(number)) {
            // check cache
            user = ctx.client.users.cache.get(str)
            if (user) {
                return ctx.completedParse(user)
            }
            
            // fetch user
            return ctx.client.users.fetch(str).then(v => ctx.completedParse(v))
        }

        // try username
        user = ctx.client.users.cache.find(u => u.username == str)
        if (user) {
            return ctx.completedParse(user)
        }
        
        return ctx.failedParse(new ParseError("No user by `" + str + "`", new StringLoc(ctx.reader, ci, ctx.reader.idx)))
    })

    public static readonly DiscordMember: Parser<GuildMember> = asyncArgumentParser(ctx => {
        let ci = ctx.reader.idx
        if (!ctx.guild.isPresent())
            return ctx.failedParse(new ParseError("Can not parse member ID outside guild context", new StringLoc(ctx.reader, ci, ci)))

        // check for user
        return this.DiscordUser.parse(ctx).use(res => {
            let user = res.value

            // try cache
            let member = ctx.guild.get().members.cache.get(user.id)
            if (member) {
                return ctx.completedParse(member)
            }

            // try fetch
            return ctx.guild.get().members.fetch(user.id).then(member => member ? 
                ctx.completedParse(member) :
                ctx.failedParse(new ParseError("No member for user `" + user.id + "`", new StringLoc(ctx.reader, ci, ctx.reader.idx))))
        })
    })

    public static readonly CodeBlocks: Parser<CodeBlock[]> = syncArgumentParser<CodeBlock[]>(ctx => {
        let reader = ctx.reader
        reader.skipWhitespace()

        let list: CodeBlock[] = []

        // find code blocks
        while (reader.current() != EOS) {
            reader.skipWhitespace()
            reader.expect("```")
            let codeBlock = new CodeBlock()

            // get language
            if (reader.current() != '\n') {
                codeBlock.lang = reader.collect(UNTIL_NEWLN)
            }

            reader.next()

            // collect code
            let tb = new StringBuilder()
            while (reader.current() != EOS && !reader.peekCheckString("```")) {
                tb.append(reader.collect(UNTIL_NEWLN))
                tb.append('\n')
                reader.next()
            }

            tb.arr.splice(tb.arr.length - 1, 1)
            codeBlock.text = tb.string()
            list.push(codeBlock)

            // skip ```
            reader.next(3)
        }

        return ctx.completedParse(list)
    }) 
}

export function createBasicAssertion(f: (ctx: CommandContext) => CommandAssertionResult): CommandAssertion {
    return new class implements CommandAssertion {
        test(ctx: CommandContext): CommandAssertionResult {
            return f(ctx)
        }
    }
}

/** Default command assertions */
export class CommandAssertions {
    public static Permissions(...perms: string[]): CommandAssertion {
        return createBasicAssertion(ctx => {
            let permissible = PermissionManager.get().forMember(ctx.member.get())
            for (let perm of perms) {
                if (permissible.check(perm, Permit.DENY) != Permit.ALLOW) {
                    return CommandAssertionResult.fail("Lacking permission `" + perm + "`")
                }
            }

            return CommandAssertionResult.SUCCESS
        })
    }

    public static DiscordPermissions(...perms: PermissionResolvable[]): CommandAssertion {
        return createBasicAssertion(ctx => {
            if (!ctx.member.isPresent())
                return CommandAssertionResult.SUCCESS

            let mp = ctx.member.get().permissions
            let cp = ctx.channel instanceof GuildChannel ? ctx.channel.permissionOverwrites : undefined
            for (let p of perms) {
                if (!mp.has(p) && (!cp || !cp.cache.has(p.toString()))) {
                    return CommandAssertionResult.fail("Lacking permission `" + p + "`")
                }
            }

            return CommandAssertionResult.SUCCESS
        })
    }
}