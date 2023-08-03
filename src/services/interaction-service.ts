import { BotService, DependencyType, ServiceManager, autoRegister, dependency, eventHandler, providedBy, provides, serviceManager } from "../services";
import { CommandService } from "./command-service";
import { DataIO, fileJsonIO } from "../util/io";
import { Channel, Client, ClientEvents, EmbedBuilder, Emoji, EmojiIdentifierResolvable, EmojiResolvable, GatewayIntentBits, Guild, GuildMember, Message, MessageReaction, PartialMessage, PartialMessageReaction, ReactionEmoji, Role, TextBasedChannel, User } from "discord.js";
import { Logger } from "../util/logging";

/** Context for serializing interaction components */
export interface InteractionSerializationLogic {
    saveComponent(component: InteractionComponent): any
    loadComponent(data: any): InteractionComponent
}

/** A serializable interaction component */
export abstract class InteractionComponent {
    /** Get the component type */
    abstract type(): string

    /**
     * Get whether this object is serializable or not.
     */
    isSerializable(): boolean { return true }

    /**
     * Get whether this object is parameterized or not.
     * 
     * If a component is not parameterized, it will just save the name of
     * the component instead of a populated parameters object.
     * 
     * If it is, it will call `saveParameters` to save the parameters
     * into a data object and `loadParameters` to load it per interaction.
     */
    isParameterized(): boolean { return false }

    /**
     * Get the name/ID of this component, only important for
     * serialized components.
     */
    name(): string { return undefined }

    /** Save the parameters of this component to the given object */
    saveParameters(ctx: InteractionSerializationLogic, to: any) { }

    /** Load the parameters from the given data and create a new parameterized instance */
    createWithParameters(ctx: InteractionSerializationLogic, from: any): InteractionComponent { return undefined }

    public key(): string {
        return this.type() + "::" + this.name()
    }
}

/** A trigger for an interaction */
export abstract class Trigger<E> extends InteractionComponent {
    /** Registers this trigger as an active cause to the given interaction */
    abstract register(interaction: Interaction<E>)
    /** Unregisters this trigger as an active cause from the given interaction */
    abstract unregister(interaction: Interaction<E>)

    isSerializable(): boolean { return true }
    isParameterized(): boolean { return false }

    override type(): string {
        return "trigger"
    }

    /** Allow both this trigger and the provided other to trigger an interaction */
    public or<E1>(trigger: Trigger<E1>): TriggerList<E | E1> {
        let list = new TriggerList()
        list.list.push(this)
        list.list.push(trigger)
        return list
    }
}

// Internal: Implementation of a list of triggers
class TriggerList<E> extends Trigger<E> {
    list: Trigger<any>[] // The list of triggers

    register(interaction: Interaction<E>) {
        this.list.forEach(t => t.register(interaction))
    }

    unregister(interaction: Interaction<E>) {
        this.list.forEach(t => t.unregister(interaction))
    }

    name(): string {
        return "list"
    }

    isSerializable(): boolean {
        return this.list.every(t => t.isSerializable())
    }

    isParameterized(): boolean {
        return true
    }

    saveParameters(ctx: InteractionSerializationLogic, to: any) {
        let list = (to.list = [])
        this.list.forEach(t => list.push(ctx.saveComponent(t)))
    }

    createWithParameters(ctx: InteractionSerializationLogic, from: any): InteractionComponent {
        let list = from.list
        if (!list)
            return
        
        let instance = new TriggerList()
        list.forEach(o => instance.list.push(ctx.loadComponent(o) as Trigger<any>))
        return instance
    }

    // just add the given trigger to the already
    // existent list and return this to save on
    // memory and performance
    public or<E1>(trigger: Trigger<E1>): TriggerList<E | E1> {
        this.list.push(trigger)
        return this
    }
}

/** A condition for interaction calls */
export abstract class Condition<E> extends InteractionComponent {
    /**
     * Checks whether the interaction under the given
     * context should execute it's actions.
     * @param ctx The interaction context
     */
    abstract check(ctx: InteractionContext<E>): boolean

    override type(): string {
        return "condition"
    }

    /** Returns a condition which is true if either this or the given other passes */
    public or(condition: Condition<E>): Condition<E> {
        let list = new OrConditionList()
        list.list.push(this)
        list.list.push(condition)
        return list
    }

    /** Invert this condition */
    public invert(): Condition<E> {
        return new InvertedCondition(this)
    }
}

// Internal: An inverted condition
class InvertedCondition<E> extends Condition<E> {
    base: Condition<E> // The base condition

    constructor(base: Condition<E> = undefined) {
        super()
        this.base = base
    }

    name(): string {
        return "inverted"
    }

    check(ctx: InteractionContext<E>): boolean {
        return !this.base.check(ctx)
    }

    isSerializable(): boolean {
        return true
    }

    isParameterized(): boolean {
        return true
    }

    saveParameters(ctx: InteractionSerializationLogic, to: any): void {
        to.base = ctx.saveComponent(this.base)
    }

    createWithParameters(ctx: InteractionSerializationLogic, from: any): InteractionComponent {
        return new InvertedCondition(ctx.loadComponent(from.base) as Condition<E>)
    }
}

// Internal: List of interaction conditions
class OrConditionList<E> extends Condition<E> {
    list: Condition<E>[] // The list of conditions

    public or(condition: Condition<E>): Condition<E> {
        this.list.push(condition)
        return this
    }

    check(ctx: InteractionContext<E>): boolean {
        for (let i = 0; i < this.list.length; i++)
            if (this.list.at(i).check(ctx))
                return true
        return false
    }

    isSerializable(): boolean {
        return true
    }

    isParameterized(): boolean {
        return true
    }

    name(): string {
        return "orList"
    }

    createWithParameters(ctx: InteractionSerializationLogic, from: any): InteractionComponent {
        let list = from.list
        if (!list)
            return

        let instance = new OrConditionList()
        list.forEach(o => instance.list.push(ctx.loadComponent(o) as Condition<any>))
        return instance
    }
    
    saveParameters(ctx: InteractionSerializationLogic, to: any) {
        let list = (to.list = [])
        this.list.forEach(t => list.push(ctx.saveComponent(t)))
    }
}

/** An action for interaction calls */
export abstract class Action<E> extends InteractionComponent { 
    /**
     * Executes the code in the given context
     * @param ctx The interaction context
     */
    abstract execute(ctx: InteractionContext<E>)

    override type(): string {
        return "action"
    }
}

/** The lifetime controller for interactions */
export abstract class InteractionLifetime {
    /** Whether the interaction should persist */
    abstract shouldPersist(ctx: InteractionContext<any>): boolean

    static readonly PERSISTENT: InteractionLifetime = new class extends InteractionLifetime {
        shouldPersist(ctx: InteractionContext<any>): boolean {
            return true
        }
    }
}

/** Context of an interaction call */
export class InteractionContext<E> {
    interaction: Interaction<E> // The interaction called
    arguments: E                // The values/arguments passed

    constructor(interaction: Interaction<E>, args: E) {
        this.interaction = interaction
        this.arguments = args
    }
}

/** Represents an interaction */
export class Interaction<E> {
    manager: InteractionManager                // The manager this interaction is registered to

    id: number                                 // The numerical unique ID of this interaction
    name: string                               // The optional name of this interaction
    persistent: boolean                        // Whether this interaction should be saved and loaded

    lifetime: InteractionLifetime              // The lifetime of the interaction
    triggers: Trigger<any>                     // The trigger which causes this interaction to be executed
    conditions: Condition<E>[] = []            // The conditions for the event to go through
    actions: Action<E>[] = []                  // The actions to be executed when this interaction is called
    meta: any = { } as any                     // The metadata on this interaction

    /** Triggers this interaction with the given context */
    public trigger(ctxRaw: InteractionContext<E> | E) {
        let ctx: InteractionContext<E>
        if (!(ctxRaw instanceof InteractionContext)) {
            ctx = new InteractionContext(this, ctxRaw)
        }

        for (let condition of this.conditions) {
            if (!condition.check(ctx))
                // condition failed so ignore this call
                return 
        }

        // invoke actions
        this.actions.forEach(a => a.execute(ctx))
    
        // handle lifetime
        if (!this.lifetime || !this.lifetime.shouldPersist(ctx)) {
            this.destroy()
        }
    }

    /** Set the name of this interaction */
    public named(name: string): this {
        this.name = name
        return this
    }

    /** Set the interaction to be persistent, optionally with a name */
    public persist(name: string = undefined): this {
        if (name)
            this.name = name
        this.persistent = true
        this.lifetime = InteractionLifetime.PERSISTENT
        return this
    }

    /** Set the interaction to only run once */
    public once(): this {
        this.lifetime = new class implements InteractionLifetime {
            shouldPersist(ctx: InteractionContext<any>): boolean {
                return false
            }
        }

        return this
    }

    /** Set the trigger for this interaction */
    public when<E1>(trigger: Trigger<E1>): Interaction<E1> {
        if (!trigger)
            throw new Error("Trigger cannot be undefined")
        this.triggers = trigger
        return this as unknown as Interaction<E1>
    }

    /** Add a condition for this interaction */
    public onlyIf(condition: Condition<E>): this {
        if (!condition)
            throw new Error("Condition cannot be undefined")
        this.conditions.push(condition)
        return this
    }

    /** Add an action to this interaction */
    public then(action: Action<E>): this {
        if (!action)
            throw new Error("Action cannot be undefined")
        this.actions.push(action)
        return this
    }   

    /** Completes building the interaction */
    public create(): this {
        this.enable()
        return this
    }

    /** Start this interaction's functionality temporarily */
    public enable(): this {
        this.triggers.register(this)
        return this
    }   

    /** Stop this interaction's functionality temporarily */
    public disable(): this {
        this.triggers.unregister(this)
        return this
    }

    /** Unregister and destroy this interaction */
    public destroy(): this {
        this.disable()
        this.manager.interactions.delete(this.id)
        this.manager.interactionsByName.delete(this.name)
        return this
    }

    public asString(): string {
        return "Interaction(id: " + this.id + (this.name ? ", name: " + this.name : "") + ")"
    }
}

/** The manager of all interactions */
@providedBy("InteractionService", DependencyType.SERVICE)
export class InteractionManager {
    // THE instance
    static readonly INSTANCE: InteractionManager = new InteractionManager()
    static get(): InteractionManager { return this.INSTANCE }

    constructor() {
        // add primitive base instances
        this.registerBaseComponent(new TriggerList())
        this.registerBaseComponent(new OrConditionList())
        this.registerBaseComponent(new InvertedCondition())

        this.serializationLogic = this.newSerializationLogic()
    }

    persistentInteractionIO: DataIO                               // The data IO to use for persistent interactions 
    baseComponents: Map<string, InteractionComponent> = new Map() // All registered base component instances
    interactions: Map<number, Interaction<any>> = new Map()       // All registered interactions by ID
    interactionsByName: Map<string, Interaction<any>> = new Map() // All registered name interactions by name
    readonly serializationLogic: InteractionSerializationLogic    // The serialization logic

    /** Get a map of all interactions */
    public all(): Map<number, Interaction<any>> {
        return this.interactions
    }

    /** Register the given base component to the registry */
    public registerBaseComponent(component: InteractionComponent) {
        this.baseComponents.set(component.key(), component)
    }

    /** Register the given interaction */
    public register(interaction: Interaction<any>) {
        if (!interaction)
            return
        interaction.manager = this
        this.interactions.set(interaction.id, interaction)
        if (interaction.name)
            this.interactionsByName.set(interaction.name, interaction)
    }

    private nextId(): number {
        return Date.now() ^ Math.random()
    }

    /** Create and register an interaction */
    public builder<E>(): Interaction<E> {
        let interaction = new Interaction()
        interaction.manager = this
        interaction.id = this.nextId()
        this.register(interaction)
        return interaction
    }

    /** Disable and remove an interaction by name */
    public remove(key: string | number) {
        let interaction: Interaction<any>
        if (typeof key == 'number') {
            interaction = this.interactions.get(key)
        } else if (typeof key == 'string') {
            interaction = this.interactionsByName.get(key)
        }

        if (interaction) {
            interaction.destroy()
        }
    }

    // Deserializes an interaction from the given source
    deserializeInteraction(ctx: InteractionSerializationLogic, src: any): Interaction<any> {
        try {
            let i = new Interaction()
            i.name = src.name
            i.id = src.id
            i.persistent = true
            i.lifetime = InteractionLifetime.PERSISTENT

            i.triggers = ctx.loadComponent(src.trigger) as Trigger<any>
            
            i.conditions = []
            let conditionList = src.conditions
            if (conditionList) {
                conditionList.forEach(s => i.conditions.push(ctx.loadComponent(s) as Condition<any>))
            }

            i.actions = []
            let actionList = src.actions
            if (actionList) {
                actionList.forEach(s => i.actions.push(ctx.loadComponent(s) as Action<any>))
            }

            return i
        } catch (e) {
            logger.warn("Failed to load interaction `" + src.name + "`", e)
            return undefined
        }
    }

    // Serializes the given interaction
    serializeInteraction(ctx: InteractionSerializationLogic, interaction: Interaction<any>): any {
        try {
            let obj = { name: interaction.name, id: interaction.id } as any
            
            obj.trigger = ctx.saveComponent(interaction.triggers)
            obj.conditions = interaction.conditions.map(c => ctx.saveComponent(c))
            obj.actions = interaction.actions.map(a => ctx.saveComponent(a))

            return obj
        } catch (e) {
            logger.warn("Failed to serialize interaction `" + interaction.name + "`", e)
            return undefined
        }
    }

    // Create the serialization logic
    private newSerializationLogic(): InteractionSerializationLogic {
        const getBaseComponent = name => this.baseComponents.get(name)
        return new class implements InteractionSerializationLogic {
            saveComponent(component: InteractionComponent): any {
                if (!component.isSerializable())
                    return "ERRUNSERIALIZABLE"

                if (!component.isParameterized())
                    return component.key()
                
                let data = { key: component.key() } as any
                component.saveParameters(this, data)
                return data
            }

            loadComponent(data: any): InteractionComponent {
                if (typeof data == 'string')
                    return getBaseComponent(data)
                return getBaseComponent(data.key).createWithParameters(this, data)
            }
        }
    }

    // Loads all persistent interactions
    public loadAllPersistentData() {
        let data = this.persistentInteractionIO.load()

        if (data.interactions) {
            (data.interactions as any[]).forEach(d => {
                let interaction = this.deserializeInteraction(this.serializationLogic, d)
                this.register(interaction)
                interaction.create()
            })
        }
    }

    // Saves all persistent interactions
    public async saveAllPersistentData() {
        let data = { } as any
        
        let interactions = data.interactions = []
        this.interactions.forEach(i => {
            if (!i.persistent) return
            let res = this.serializeInteraction(this.serializationLogic, i)
            if (res)
                interactions.push(res)
        })

        this.persistentInteractionIO.save(data)
    }
}

let logger: Logger

@autoRegister()
export class InteractionService extends BotService {
    @dependency(CommandService)
    commandService: CommandService

    @provides(InteractionManager)
    interactionManager: InteractionManager = InteractionManager.get()

    onLoad(manager: ServiceManager): void {
        logger = this.logger

        this.interactionManager.persistentInteractionIO = fileJsonIO("interaction-service/persistent-interactions.json") 
        this.interactionManager.loadAllPersistentData()
    }

    @eventHandler("saveData")
    save(p: any) { 
        if (p.reason != 'autosave-interval') {
            this.logger.info("Saving persistent interaction data")
        }
        
        this.interactionManager.saveAllPersistentData()
    }
}

function registerBaseComponent<T extends InteractionComponent>(v: T): T {
    InteractionManager.get().registerBaseComponent(v)
    return v
}

function createDiscordEventTrigger<K extends keyof ClientEvents, M>(event: K, mapper: (...args: ClientEvents[K]) => M): Trigger<M> {
    // listener logic
    let listeners = []
    serviceManager.on('preLoad', _ => {
        let client: Client = serviceManager.getSingleton(Client)
        client.on(event, (...args) => {
            let mapped = mapper(...args)
            listeners.forEach(l => l.interaction.trigger(mapped))
        })
    })

    // create trigger
    const name = "discord." + event
    return registerBaseComponent(new class extends Trigger<M> {
        name(): string {
            return name
        }

        register(interaction: Interaction<M>) {
            listeners.push({ interaction: interaction })
        }

        unregister(interaction: Interaction<M>) {
            listeners.splice(listeners.findIndex(i => i.interaction == interaction), 1)
        }
    })
}

function createParamCondition<E, P>(name: string, func: (e: E, p: P) => boolean): ParamCondition<E, P> {
    return registerBaseComponent(new ParamCondition(name, { } as P, func))
} 

function createSimpleCondition<T>(name: string, func: (t: T) => boolean): Condition<T> {
    return registerBaseComponent(new class extends Condition<T> {
        override name(): string {
            return name
        }

        override check(ctx: InteractionContext<T>): boolean {
            return func(ctx.arguments)
        }
    })
}

function createParamAction<E, P>(name: string, func: (e: E, p: P) => void): ParamAction<E, P> {
    return registerBaseComponent(new ParamAction(name, { } as P, func))
} 

function createSimpleAction<E>(name: string, func: (e: E) => void): Action<E> {
    return registerBaseComponent(new class extends Action<E> {
        name(): string {
            return name
        }

        execute(ctx: InteractionContext<E>) {
            func(ctx.arguments)
        }
    })
}

/** A parameterized condition */
export class ParamCondition<E, P> extends Condition<E> {
    nameConst: string       // The name
    params: P               // The parameters
    func: (E, P) => boolean // The function

    constructor(name: string, params: P, func: (E, P) => boolean) {
        super()
        this.nameConst = name
        this.params = params
        this.func = func
    }

    name(): string {
        return this.nameConst
    }

    check(ctx: InteractionContext<E>): boolean {
        return this.func(ctx.arguments, this.params)
    }

    isSerializable(): boolean { return true }
    isParameterized(): boolean { return true }

    saveParameters(ctx: InteractionSerializationLogic, to: any): void {
        Object.entries(this.params).forEach(v => to[v[0]] = v[1])
    }

    createWithParameters(ctx: InteractionSerializationLogic, from: any): InteractionComponent {
        let params = { } as any
        Object.entries(from).filter(e => e[0] != 'key').forEach(e => params[e[0]] = e[1])
        return this.set(params)
    }

    /** Create a new instance with the given parameters */
    public set(params: P): ParamCondition<E, P> {
        return new ParamCondition(this.nameConst, params, this.func)
    }
    
    /** Create a new instance with the given parameters */
    public with(params: P): ParamCondition<E, P> {
        return this.set(params)
    }
}

/** A parameterized action */
export class ParamAction<E, P> extends Action<E> {
    nameConst: string    // The name
    params: P            // The parameters
    func: (E, P) => void // The function

    constructor(name: string, params: P, func: (E, P) => void) {
        super()
        this.nameConst = name
        this.params = params
        this.func = func
    }

    name(): string {
        return this.nameConst
    }

    isSerializable(): boolean { return true }
    isParameterized(): boolean { return true }

    execute(ctx: InteractionContext<E>) {
        this.func(ctx.arguments, this.params)
    }

    saveParameters(ctx: InteractionSerializationLogic, to: any): void {
        Object.entries(this.params).forEach(v => to[v[0]] = v[1])
    }

    createWithParameters(ctx: InteractionSerializationLogic, from: any): InteractionComponent {
        let params = { } as any
        Object.entries(from).filter(e => e[0] != 'key').forEach(e => params[e[0]] = e[1])
        return this.set(params)
    }

    /** Create a new instance with the given parameters */
    public set(params: P): ParamAction<E, P> {
        return new ParamAction(this.nameConst, params, this.func)
    }

    /** Create a new instance with the given parameters */
    public with(params: P): ParamAction<E, P> {
        return this.set(params)
    }
}

/** Create a condition by function */
export function condition<T>(pred: (v: T) => boolean) {
    return new class extends Condition<T> {
        isSerializable(): boolean {
            return false
        }

        check(ctx: InteractionContext<T>): boolean {
            return pred(ctx.arguments)
        }
    }
}

/** Create an action by function */
export function action<T>(func: (v: T) => void) {
    return new class extends Action<T> {
        isSerializable(): boolean {
            return false
        }

        execute(ctx: InteractionContext<T>) {
            func(ctx.arguments)
        }
    }
}

/* -------------- Standard Library -------------- */

// EVENT CONTENT TYPES //
export type IHasUser = { user: User }
export type IHasGuild = { guild: Guild }
export type IHasMember = IHasUser & IHasGuild & { member: GuildMember }
export type IHasChannel = { channel: Channel }
export type IHasMessage = IHasChannel & IHasGuild & IHasMember & { message: Message | PartialMessage }
export type IHasReaction = IHasMessage & { reaction: PartialMessageReaction | MessageReaction }

// PARAMETER TYPES //
export type IdParam = { id: string }
export type ReactionEmojiParam = { emoji: ReactionEmoji | EmojiIdentifierResolvable }

/** Standard Triggers */
export class Triggers {
    public static readonly GuildMemberAdded: Trigger<IHasMember> 
        = createDiscordEventTrigger('guildMemberAdd', (member) => { return { member: member, guild: member.guild, user: member.user } })

    public static readonly MessageCreate: Trigger<IHasMessage>
        = createDiscordEventTrigger('messageCreate', (message) => { return { message: message, guild: message.guild, channel: message.channel, member: message.member, user: message.member.user } })

    public static readonly ReactionAdded: Trigger<IHasReaction>
        = createDiscordEventTrigger('messageReactionAdd', (reaction) => { let message = reaction.message; return { reaction: reaction, message: message, user: reaction.users.cache.last(), member: undefined, guild: message.guild, channel: message.channel } })
}

/** Standard Conditions */
export class Conditions {
    public static readonly UserIsBot: Condition<IHasUser>
        = createSimpleCondition<IHasUser>("userIsBot", o => o.user.bot)

    public static readonly IsSameMessage: Condition<IHasMessage>
        = createParamCondition<IHasMessage, IdParam>("isMessage", (e, p) => e.message.id == p.id)

    public static readonly IsReactionEmoji: Condition<IHasReaction>
        = createParamCondition<IHasReaction, ReactionEmojiParam>("isReactionEmoji", (e, p) => e.reaction.emoji.name == p.emoji)
}

/** Standard Actions */
export class Actions {
    public static readonly GiveRole: ParamAction<IHasMember, IdParam>
        = createParamAction<IHasMember, IdParam>("giveRole", (e, params) => e.member.roles.add(params.id))  

    public static readonly RemoveRole: ParamAction<IHasMember, IdParam>
        = createParamAction<IHasMember, IdParam>("removeRole", (e, params) => e.member.roles.remove(params.id)) 

    public static readonly ReactWithEmoji: Action<IHasMessage>
        = createParamAction<IHasMessage, ReactionEmojiParam>("reactWithEmoji", (e, p) => e.message.react(p.emoji))
}

// Warned Confirm Message
export type MessageConfirmResult = { message: Message, confirmed: boolean }
export function warnedConfirmMessage(channel: TextBasedChannel, member: GuildMember, warning: string): Promise<MessageConfirmResult> {
    return channel.send({ embeds: [
        new EmbedBuilder()
        .setColor("#ffcc4d")
        .setDescription(":warning:\n" + warning)
    ]}).then<Promise<MessageConfirmResult>>((msg: Message) => {
        msg.react('✅')
        msg.react('❌')
        return new Promise<MessageConfirmResult>((resolve, reject) => {
            let complete = v => {
                msg.reactions.removeAll()
                resolve(v)
            }

            let interaction = InteractionManager.get().builder()
                .once()
                .when(Triggers.ReactionAdded)
                .onlyIf(condition(d => d.message.id == msg.id))
                .onlyIf(condition(d => d.user.id == member.id))
                .then(action(data => {
                    let emoji = data.reaction.emoji
                    if (emoji.name == '✅') complete({ message: msg, confirmed: true })
                    else complete({ message: msg, confirmed: false })
                }))
                .create()

            // set confirmation timeout
            setTimeout(() => {
                interaction.destroy()
                complete({ message: msg, confirmed: false })
            }, 10 * 1000)
        })
    }).then(r => r)
}