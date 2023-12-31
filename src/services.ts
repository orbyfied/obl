/*
    ------------ Service System ------------

    This system manages services, modules and dependencies including singletons.

    Service: A system/part of the program which provides core functionality
             which the rest of the bot can depend on. This does not provide any
             user related services. Example: DataStoreService provides the database
    Module: A part of the bot which is accessible to users and may provide functionality
            to the rest of the bot. Example: XPModule provides the XP system as well as
            commands to interact with that.
    Singletons: Singletons can be registered to the manager and can be injected automatically
                into modules and services using the dependency injection system.

    ---------------------------------------

*/

import { ClientEvents } from "discord.js";
import { Logger } from "./util/logging";
import 'reflect-metadata'
import './util/reflect'
import { getPrototypeName, isOfType, getClassChain } from "./util/reflect";
import { Future } from "./util/future";
import { EventEmitter } from "events";

// Helper for dependency type names
export enum DependencyType {
    SERVICE = "services",
    SERVICES = "services",
    MODULE = "modules",
    MODULES = "modules",
    SINGLETON = "singletons",
    SINGLETONS = "singletons"
}

const logger: Logger = new Logger("ServiceManager")

function callOnAll(entries: object, f: Function) {
    Object.entries(entries).forEach(e => f(e[1]))
}

/** Signals an unresolved dependency */
class _UNRESOLVED {
    toString() {
        return "UNRESOLVED"
    }
}

export const UNRESOLVED = new _UNRESOLVED()

/** Represents a provider of a dependency */
export abstract class DependencyProvider<T> {
    constructor(name: string) {
        this.name = name
    }

    public readonly name: string // The name of this resolver

    public abstract findDependency(name: string): T
    public abstract addDependency(name: string, value: T)
}

/** Nested document dependency resolver */
export function nestedDocumentDependencyProvider(name: string, docSupplier: (() => any) | any, list?: any[],
        vSet: (on: any, k: string, v: any) => void = (o, k, v) => o[k] = v, vGet: (on: any, k: string) => void = (o, k) => o[k],
        vNew: () => any = () => { }): 
        DependencyProvider<any> {

    const getDoc = () => {
        let doc: any = docSupplier
        if (typeof doc == 'function')
            doc = doc()
        return doc
    }

    return new class extends DependencyProvider<any> {
        public findDependency(name: string) {
            let split = name.split(".")
            let current = getDoc()
            for (let i = 0; i < split.length; i++) {
                let part = split[i]

                // get next document
                current = vGet(current, part)
                if (current == null || current == undefined) {
                    return current
                }
            }

            return current
        }

        public addDependency(name: string, value: any) {
            if (list)
                list.push(value)

            let current = getDoc()
            let split = name.split(".")
            for (let i = 0; i < split.length - 1; i++) {
                let part = split[i]

                // get next document
                let old = current
                current = vGet(current, part)
                if (current == null || current == undefined) {
                    current = vNew()
                    vSet(old, part, current)
                }
            }

            vSet(current, split[split.length - 1], value)
        }
    } (name)
}

/** Get the dependency/service name for the given type. */
export function getDependencyNameForPrototype(type: object) {
    return getPrototypeName(type)
}

/** Derive the dependency/service name from the given key */
export function getDependencyNameForKey(key: string | object, k2?: string) {
    if (typeof key == 'string')
        return key + (k2 ? ":" + k2 : "")
    return getDependencyNameForPrototype(key) + (k2 ? ":" + k2 : "") // Get from prototype
}

/** Derive the dependency type from the given key */
export function estimateDependencyProvider(key: string | object, def: string = ""): string {
    if (typeof key == 'string') {
        // check extension
        key = key.toLowerCase()
        if (key.endsWith("service")) return "services"
        if (key.endsWith("module")) return "modules"
        return "singletons"
    }

    if (isOfType(key, BotService)) return "services"
    if (isOfType(key, BotModule)) return "modules"
    return "singletons"
}

/** An object which always has a key associated */
export interface Keyed<K> {
    key(): K
}

// All events the service manager may emit
export interface ServiceManagerEvents {
    preLoad: [ServiceManager]
    load: [ServiceManager]
    postLoad: [ServiceManager]
    preReady: [ServiceManager]
    ready: [ServiceManager]
}

/** Central manager class. */
export class ServiceManager extends EventEmitter {
    public static get(): ServiceManager {
        return serviceManager
    }

    constructor() {
        super()
        this.eventBus = new EventBus()

        this.services = { }
        this.modules = { }
        this.singletons = { }

        this.addDependencyProvider(nestedDocumentDependencyProvider("services", this.services, this.servicesList))
        this.addDependencyProvider(nestedDocumentDependencyProvider("modules", this.modules, this.modulesList))
        this.addDependencyProvider(nestedDocumentDependencyProvider("singletons", this.singletons))
    }

    eventBus: EventBus                                                    // The main event bus

    dependencyProviders: Map<string, DependencyProvider<any>> = new Map() // All dependency providers by name
    services: Object                                                      // All services by name
    servicesList: BotService[] = []                                       // All services in an array
    modules: Object                                                       // All modules by name
    modulesList: BotModule[] = []                                         // All modules in an array
    singletons: Object                                                    // Singleton Map for dependency injection

    gInjectCtx: InjectContext                                             // The injection context for the global variables

    getService(key: string | object, k2?: string) {
        return this.services[getDependencyNameForKey(key, k2)]
    }

    getModule(key: string | object, k2?: string) {
        return this.modules[getDependencyNameForKey(key, k2)]
    }

    getSingleton(key: string | object, k2?: string) {
        return this.singletons[getDependencyNameForKey(key, k2)]
    }
    
    /** Register a module to the service manager */
    public addModule(module: BotModule): ServiceManager {
        this.modules[module.name] = module;
        this.modulesList.push(module)
        return this
    }

    /** Register a service to the service manager */
    public addService(service: BotService): ServiceManager {
        this.services[service.name] = service;
        this.servicesList.push(service)
        return this
    }

    /** Register a new singleton */
    public addSingleton(singleton: object, k2?: string): ServiceManager {
        if (!singleton)
            return
        if (typeof singleton != 'object') {
            this.singletons[getDependencyNameForKey(typeof singleton, k2)] = singleton
            return this
        }

        getClassChain(Object.getPrototypeOf(singleton)).forEach(p => {
            this.singletons[getDependencyNameForKey(p, k2)] = singleton
        })

        return this
    }

    /** Get the dependency under the given provider and key */
    public getDependency<T>(provider: string, key: string): T {
        let p = this.getDependencyProvider(provider)
        if (!p) {
            console.log("couldnt find provider for .getDependency(" + key + "): ", provider)
            return undefined
        }

        return p.findDependency(key)
    }

    /** Register the given dependency under the given provider and key */
    public addDependency(provider: string, key: string, value: any) {
        let p = this.getDependencyProvider(provider)
        if (!p) {
            console.log("couldnt find provider for .addDependency(" + key + "): ", provider)
            return undefined
        }

        p.addDependency(key, value)
    }

    /** Register a dependency provider by a specific name */
    public addDependencyProvider(provider: DependencyProvider<any>) {
        this.dependencyProviders.set(provider.name, provider)
    }

    /** Get the dependency provider by the given name */
    public getDependencyProvider(name: string): DependencyProvider<any> {
        return this.dependencyProviders.get(name)
    }

    /** Get a list of all registered services */
    public allServices(): BotService[] {
        return this.servicesList
    }

    /** Get a list of all registered modules */
    public allModules(): BotModule[] {
        return this.modulesList
    }

    /** Register all autoRegister annotated elements */
    public autoRegisterAll() {
        let list = global["___auto_register"]
        if (list == undefined)
            return

        list.forEach(e => {
            let { type, classConstructor } = e

            // create new instance
            let instance = Reflect.construct(classConstructor, [])

            if (type == null) {
                if (instance instanceof BotService) {
                    type = "services"
                } else if (instance instanceof BotModule) {
                    type = "modules"
                } else {
                    type = "singleton"
                }
            }

            this.addDependency(type, instance["name"], instance)
        })
    }

    /** On load, load everything */
    loadAll() {
        this.emit('preLoad', this)
        this.servicesList.forEach(s => s.load(this))
        this.modulesList.forEach(s => s.load(this))
        injectDependencies(global, this, InjectStage.Load, this.gInjectCtx = new InjectContext()) 
        this.emit('load', this)

        // post load
        this.servicesList.forEach(s => s.postLoad(this))
        this.modulesList.forEach(s => s.postLoad(this))
        injectDependencies(global, this, InjectStage.PostLoad, this.gInjectCtx = new InjectContext()) 
        this.emit('postLoad', this)
    }

    /** On ready, ready everything */
    readyAll() {
        this.emit('preReady', this)
        this.servicesList.forEach(s => s.ready(this))
        this.modulesList.forEach(s => s.ready(this))
        injectDependencies(global, this, InjectStage.Ready, this.gInjectCtx = new InjectContext()) 
        this.emit('ready', this)
    }

    /* EventEmitter helper */
    public on<K extends keyof ServiceManagerEvents>(event: K, listener: (...args: ServiceManagerEvents[K]) => void): this { return super.on(event, listener);  }
    public once<K extends keyof ServiceManagerEvents>(event: K, listener: (...args: ServiceManagerEvents[K]) => void): this { return super.once(event, listener);  }

}

/* ----------------- Dependency Injection ----------------- */

/** Tries to resolve the dependency instance from the given manager */
function resolveDependency(providerName: string, name: string, manager: ServiceManager): any {
    return manager.getDependency(providerName, name)
}

/** Invokes the loading of the given dependency if it is loadable */
function loadDependency(dep: Object, manager: ServiceManager) {
    if (dep["loaded"] == undefined || dep["load"] == undefined) // not loadable
        return
    dep["load"](manager) // invoke load
}

class InjectContext {
    warnings: Map<object, string> = new Map()
    
    /** Print all warnings */
    print() {
        this.warnings.forEach(v => {
            logger.warn(v)
        })
    }
}

/** Helper function, injects all declared dependencies into the instance. */
function injectDependencies(instance: Object, manager: ServiceManager, stage: string, ctx: InjectContext) {
    let dependencies: Object[] = Object.getPrototypeOf(instance)["___dependencies"]
    if (dependencies == undefined)
        return // nothing to inject

    dependencies.forEach(dependency => {
        let provider: string      = dependency["provider"]
        let key: object           = dependency["key"]
        let k2: string            = dependency["k2"]
        let name: string          = dependency["name"]
        let property: string      = dependency["property"]
        let expectedStage: string = dependency["stage"]

        // check if the dependency has been injected already
        let current = instance[property]
        if (current && current != UNRESOLVED)
            return

        let dependencyValue = UNRESOLVED

        // check if the dependency is provided by a provider
        if (key["___provided_by"]) {
            let { providerName, providerProvider } = key["___provided_by"]

            // resolve provider dependency
            let provider = resolveDependency(providerProvider, providerName, manager)
            let ppt: any
            if (!provider || !(ppt = Object.getPrototypeOf(provider))["___provides"]) {
                return
            }

            // look for providing property
            let pInfo = (ppt["___provides"] as any[]).find(a => a.name == name)
            if (!pInfo) {
                return
            }

            // load and get dependency value
            loadDependency(provider, manager)
            let propertyKey = pInfo.propertyKey
            dependencyValue = provider[propertyKey]
        } else {
            dependencyValue = resolveDependency(provider, name + (k2 ? ":" + k2 : ""), manager)
            if (!dependencyValue) {
                const warning = "Could not resolve dependency(name: " + name + ", provider: " + provider + ") for object(.name: " + instance["name"] + ") " +
                    "atStage(" + stage + ")" + (expectedStage ? " expectedAt(" + expectedStage + ")" : "")
                
                // log immediately as it was expected here
                if (expectedStage == stage) {
                    logger.warn(warning)
                } 
                
                // queue the warning for the end of the injection process
                if (!expectedStage) {
                    ctx.warnings.set(dependency, warning)
                }
                
                instance[property] = UNRESOLVED
                return
            } else {
                // remove warning from the context
                ctx.warnings.delete(dependency)
            }
        }
        
        loadDependency(dependencyValue, manager)
        instance[property] = dependencyValue
        if (dependencyValue["onInject"])
            dependencyValue["onInject"](manager, instance, property)
    });
}

/** Defined injection stages */
export class InjectStage {
    static Load:     string = "load"
    static PostLoad: string = "postload"
    static Ready:    string = "ready"
}

/** Creates a key pair */
export function k2(key: string | object, k2?: string) {
    return { key: key, k2: k2 }
}

/**
 * Decorator: @dependency for fields
 */
export function dependency(key: string | object, stage: string = null, provider: string = null) {
    return function(target: Object, propertyKey: string) {
        // extract key pair from the key
        let k2 = undefined
        if (key["k2"]) {
            k2 = key["k2"]
            key = key["key"]
        }

        // get name and type from the key
        let name = getDependencyNameForKey(key)
        let provider: string
        let idxOfSlash: number = name.indexOf("/")
        if (idxOfSlash != -1) {
            provider = name.split('/')[0]
            name = name.substring(idxOfSlash + 1)
        } else {
            provider = provider ? provider : estimateDependencyProvider(key, "services|singletons")
        }

        // get dependency list
        let list = target["___dependencies"] as any[]
        if (!list) target["___dependencies"] = (list = [])

        // add dependency
        list.push({
            "provider": provider,
            "key": key,
            "k2": k2,
            "name": name,
            "property" : propertyKey,
            "stage": stage
        })
    }
}

/** Denotes that the service/module should automatically be registered */
export function autoRegister(type: string = null) {
    return (classConstructor: Function) => {
        // register class as auto registerable
        let list = global["___auto_register"] as any[]
        if (!list) global["___auto_register"] = (list = [])
        list.push({
            "classConstructor": classConstructor,
            "type": type
        })
    }
}

/** Denotes that the singleton type is provided by the given prototype */
export function providedBy(key: string | object, type: string = undefined) {
    let name = getDependencyNameForKey(key)
    let provider = type ? type : estimateDependencyProvider(key)
    return (classConstructor: Function) => {
        // register property
        classConstructor["___provided_by"] = {
            providerName: name,
            providerProvider: provider
        }
    }
}

/** Denotes that the field provides the given singleton once loaded */
export function provides(key: string | object) {
    let name = getDependencyNameForKey(key)
    return function(target: Object, propertyKey: string) {
        // get dependency list
        let list = target["___provides"] as any[]
        if (!list) target["___provides"] = (list = [])

        list.push({
            name: name,
            propertyKey: propertyKey
        })
    }
}

/* ----------------- Service Classes ----------------- */

/**
 * Provides internal services to the bot.
 */
export abstract class BaseService implements Keyed<string> {
    name: string                         // The name of this service/module
    loaded: boolean = false              // Whether this service/module has successfully been loaded
    manager: ServiceManager              // The service manager, set on load

    protected logger: Logger             // The logger instance created on construction

    private injectContext: InjectContext // The injection context

    constructor(name: string = undefined) {
        if (name == undefined) {
            name = getDependencyNameForPrototype(Object.getPrototypeOf(this))
        }

        this.name = name;
        this.logger = new Logger(name)
        this.injectContext = new InjectContext()
    }

    key(): string {
        return this.name
    }

    // EVENTS
    public afterLoad: Future<void> = new Future()
    public afterPostLoad: Future<void> = new Future()
    public afterReady: Future<void> = new Future()

    /**
     * Called when this service should be loaded. At this point
     * all dependencies have been injected.
     * @param manager The bot manager, which grants access to the rest of the bot.
     */
    onLoad(manager: ServiceManager) { }

    /**
     * Called after all services and modules have been loaded.
     * @param manager The bot manager, which grants access to the rest of the bot.
     */
    onPostLoad(manager: ServiceManager) { }

    /**
     * Called when the bot is ready and this service should be initialized.
     * @param manager The bot manager, which grants access to the rest of the bot.
     */
    onReady(manager: ServiceManager) { }

    /**
     * Called when this instance is injected into the given object.
     */
    onInject(manager: ServiceManager, into: object, property: string) { }

    protected abstract preLoad(manager: ServiceManager);
    public load(manager: ServiceManager) { 
        this.manager = manager
        if (this.loaded) return

        try {
            this.preLoad(manager)

            registerListeners(this, manager.eventBus)

            // resolve, load and inject dependencies
            injectDependencies(this, manager, "load", this.injectContext)

            // finally load this instance
            this.onLoad(manager)
            this.loaded = true

            // call after load
            this.afterLoad.complete()
        } catch (e) {
            logger.error("Error occured in " + this.name + ".load(): {0}", e)
        }
    }

    public postLoad(manager: ServiceManager) {
        try {
            // second round of dependency injection
            injectDependencies(this, manager, "postLoad", this.injectContext)

            // call post load
            this.onPostLoad(manager)

            // call after post load
            this.afterPostLoad.complete()
        } catch (e) {
            logger.error("Error occured in " + this.name + ".postLoad(): {0}", e)
        }
    }

    public ready(manager: ServiceManager) {
        try {
            // final round of dependency injection
            injectDependencies(this, manager, "ready", this.injectContext)
            this.injectContext.print()
            
            // call on ready
            this.onReady(manager)

            // call after ready
            this.afterReady.complete()
        } catch (e) {
            logger.error("Error occured in " + this.name + ".ready(): {0}", e)
        }
    }
}

/**
 * Provides internal services to the bot.
 */
export abstract class BotService extends BaseService implements Keyed<string> {
    constructor(name: string = undefined) {
        super(name)
    }

    protected preLoad(manager: ServiceManager) {
        logger.info("Loading service({0})", this.name)
    }
}

/**
 * Provides functionality to the bot.
 */
export abstract class BotModule extends BaseService implements Keyed<string> {
    constructor(name: string = undefined) {
        super(name)
    }

    protected preLoad(manager: ServiceManager) {
        logger.info("Loading module({0})", this.name)
    }
}

/* ----------------- Event System ----------------- */

/** The data object for the event call */
export class EventCall {
    constructor(event: string, args: any[], mutable: boolean) {
        this.event = event
        this.args = args
        this.mutable = mutable
    }

    event: string      // The event name
    args: any[]        // The event arguments

    mutable: boolean   // Whether the result of this event can be modified
    cancelled: boolean // Whether the event has been cancelled
                       // This will only have effect on events marked as mutable
        
    /**
     * Set the given value as the cancel state on this event call.
     * @param value The cancel state
     */
    cancel(value: boolean): EventCall {
        this.cancelled = value
        return this
    }
}

/** An event listener which can receive events from the event bus */
export abstract class EventListener {
    constructor(event: string) {
        this.event = event
    }

    event: string // The name of the event 

    /**
     * Handles the called events.
     * @param call The event call information.
     */
    abstract handle(call: EventCall)

    /**
     * Get the priority of this listener.
     */
    abstract priority(): number
}

/** A list of listeners */
export class MultiListener extends EventListener {
    constructor(event: string) {
        super(event)
    }

    user: Array<EventListener> = []         // The user defined event listeners
    start: Future<EventCall> = new Future() // The begin future called before the user listeners
    end: Future<EventCall> = new Future()   // The end future called after all user listeners

    // Add the given listener to the list
    addListener(listener: EventListener) {
        let i1 = 0
        for (let i = 0; i < this.user.length; i++) {
            let l = this.user[i]

            if (l.priority() > listener.priority()) {
                // insert listener
                i1 = i
                break
            }
        }

        this.user.splice(i1, 0, listener)
    }

    override handle(call: EventCall) {
        this.start.complete(call)
        this.user.forEach(listener => listener.handle(call))
        this.end.complete(call)
    }

    override priority(): number {
        return 0
    }
}

// Internal: function calling listener
// Pre-calculates the argument array
class FunctionEventListener extends EventListener {
    constructor(event: string, instanceThis: object, options) {
        super(event)
        this.instanceThis = instanceThis
        this.func = options.func
        this.delay = options.delay
        this.listenerPriority = options.priority
    }

    instanceThis: object     // The parameter which should be passed as this
                             // Set to null to indicate exclusion of this parameter

    func: Function           // The function to call with the arguments

    delay: number            // After how many MS should the call go through

    listenerPriority: number // The priority of this listener

    override handle(call: EventCall) {
        // call with provided arguments
        let args: any[] = call.args
        
        // Synchronous Call
        if (this.delay == -1) {
            let ret: any = this.func.call(this.instanceThis, ...args)

            // interpret boolean return values as the event
            // cancel status (true = cancelled, false = continue,
            // null|undefined = unmodified)
            if (typeof ret == 'boolean') {
                call.cancel(ret)
            }

            return
        } else {
            // Delayed Call (no return type can be registered)
            setTimeout(() => this.func.call(this.instanceThis, ...args), this.delay)
            return
        }
    }

    override priority(): number {
        return this.listenerPriority
    }
}

/** The event bus */
export class EventBus {
    private listeners: Map<string, MultiListener> = new Map()   // The base listeners keyed by event name

    private onNewBaseListener: ((MultiListener) => void)[] = [] // Listeners for new base listeners

    /**
     * Run the given function for all registered base listeners
     * and base listeners registered in the future.
     * @param func The function.
     */
    public forAllEvents(func: (MultiListener) => void) {
        this.onNewBaseListener.push(func)
        this.listeners.forEach(func)
    }

    /** 
     * Register the given event listener to this event bus.
     * @param listener The event listener to register.
     */
    public register(listener: EventListener) {
        let event = listener.event
        let base = this.listeners.get(event)
        if (!base) { 
            this.listeners.set(event, base = new MultiListener(event))
            this.onNewBaseListener.forEach(f => f(base))
        }

        base.addListener(listener)
    }

    /**
     * Publish the given event call to the appriopriate listeners.
     * @param call The event call to publish
     */
    public publish(call: EventCall): EventCall {
        let event = call.event
        let base = this.listeners.get(event)
        if (!base)
            return call // no listeners to call

        base.handle(call)
        return call
    }

    /**
     * Call an event by the given name with the given
     * arguments. The event call constructed by this
     * is not mutable.
     * @param event The event
     * @param args The arguments
     */
    public call(event: string, args: any[]): EventCall {
        let call = new EventCall(event, args, false)
        return this.publish(call)
    }
}

/** Decorator on methods, declares the method as an event handler */
export function eventHandler(event: string, priority: number = 0, delay: number = -1) {
    return function(target: object, propertyKey: string, descriptor: PropertyDescriptor) {
        // get the event handler list
        let list = target["___event_handlers"] as any[]
        if (!list) target["___event_handlers"] = (list = [])

        list.push({
            "property": propertyKey,
            "event": event, // Event name
            "priority": priority,
            "delay": delay
        })
    }
}

/** Register all listeners defined in instance to the given event bus */
export function registerListeners(instance: object, eventBus: EventBus) {
    let list = instance["___event_handlers"] as any[]
    if (!list) return

    list.forEach(rawData => {
        let listener = new FunctionEventListener(rawData.event, instance, {
            func: instance[rawData.property],
            priority: rawData.priority,
            delay: rawData.delay
        })

        eventBus.register(listener)
    })
}

/* Discord JS event handler decorator
   Automatically prefixes any given event name with 
   "@discord." */
export function discordEventHandler(event: keyof ClientEvents, priority: number = 0, delay: number = -1) {
    return eventHandler("@discord." + event, priority, delay)
}

export const serviceManager: ServiceManager = new ServiceManager()