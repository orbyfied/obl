/* Operational Imports */
import { Client, ClientOptions, GatewayIntentBits } from "discord.js"
import { Logger } from './util/logging';
import { EventBus, ServiceManager } from "./services";
import { openConsole } from './console';
import { resolvePath } from "./util/paths";
import { DatabaseProvider } from "./services/db-service";

const path = require("path")
const fs = require("fs")

// set up base logging
const logger = new Logger("Main");

export type BootstrapOptions = {
    autoSaveInterval: number
}

const DEFAULT_OPTIONS: BootstrapOptions = {
    autoSaveInterval: 1000 * 60 * 2 // 2 minutes
}

/** Bootstrapper class */
export class OBLBootstrap {

    readonly options: BootstrapOptions

    /** The service manager instance */
    public readonly serviceManager: ServiceManager = new ServiceManager()

    /** The event bus from the service manager */
    public readonly eventBus: EventBus = this.serviceManager.eventBus

    /** The Discord client instance */
    public client: Client

    private currentPromise: Promise<any> = Promise.resolve() // The current promise being awaited

    constructor(options: BootstrapOptions) {
        this.options = options

        // set autosave interval
        setInterval(() => {
            this.eventBus.call("saveData", [{ 
                reason: "autosave-interval" 
            }])
        }, options.autoSaveInterval)

        // set exit hook
        process.on("exit", () => {
            this.eventBus.call("saveData", [{ 
                reason: "exit-hook" 
            }])
        })
    }

    /** Require all default modules and services provided by OBL */
    public requireDefaults(): this {
        this.requireAll(__dirname + "/services")
        this.requireAll(__dirname + "/modules")
        return this
    }

    /** Recursively requires all scripts in the given directorys */
    public requireAll(dir: string): this {
        dir = resolvePath(dir)
        if (!fs.existsSync(dir))
            return

        fs.readdirSync(dir).forEach(fn => {
            let pathStr = path.join(dir, fn)

            // check extension
            if (fn.endsWith(".js") || fn.endsWith(".ts")) {
                require(pathStr.replace(".ts", "").replace(".js", ""))
            }

            // check for dir
            if (fs.lstatSync(pathStr).isDirectory()) {
                this.requireAll(dir)
            }
        })

        return this
    }

    /** Create the client instance */
    public createClient(options?: ClientOptions): this {
        return this.then(_ => {
            // collect gateway intents
            let requiredIntents: Set<GatewayIntentBits> = new Set()
            this.serviceManager.allServices().forEach(s => { if (s["requiredDiscordIntents"]) s["requiredDiscordIntents"].forEach(i => requiredIntents.add(i)) })
            this.serviceManager.allModules().forEach(s => { if (s["requiredDiscordIntents"]) s["requiredDiscordIntents"].forEach(i => requiredIntents.add(i)) })

            if (!options)
                options = { intents: [] }
            requiredIntents.forEach(b => options.intents["push"](b))
            console.log(options.intents)
            this.client = new Client(options)
            this.client.once('ready', _ => {
                logger.info("Connected to Discord as user({0}) userId({1})", this.client.user.username, this.client.user.id);

                this.eventBus.call("preReady", [this.client])
                this.onReady()
                this.eventBus.call("postReady", [this.client])
            })

            // add discord.js event calls to event bus
            this.eventBus.forAllEvents(listener => {
                let event: string = listener.event
                if (!event.startsWith("@discord.")) return

                let djsEvent = event.substring("@discord.".length)

                this.client.on(djsEvent, (...args) => {
                    this.eventBus.call(event, args)
                })
            })
        }, "creation of the discord client")
    }

    /** Register the primary database provider */
    public database(db: DatabaseProvider<any>): this {
        this.serviceManager.addSingleton(db)
        return this.then(_ => db.connect())
    }

    /** Loads all registered services and modules */
    public loadAll(): this {
        return this.then(_ => {
            this.serviceManager.autoRegisterAll()
            this.serviceManager.loadAll()
        }, "loading services")
    }

    /** Propegates the ready events */
    onReady(): this {
        this.serviceManager.readyAll()
        return this
    }

    /** Start the console worker */
    public openConsole(): this {
        openConsole(this.serviceManager)
        return this
    }

    /** Log the Discord bot in */
    public login(token: string): this {
        return this.then(_ => this.client.login(token), "login")
    }

    // Connect a new handler to the startup promise chain
    then<TResult1>(onfulfilled?: ((value: OBLBootstrap) => TResult1 | PromiseLike<TResult1>) | undefined | null, stage?: string): this {
        this.currentPromise = this.currentPromise
            .then(_ => onfulfilled(this))
            .catch(e => logger.error("A fatal error occured in {0}: {1} \x1b[41m\x1b[31m[TERMINATING]\x1b[0m", stage ? stage : "startup", e))
        return this
    }

    /** Get the current promise */
    public promise(): Promise<OBLBootstrap> {
        return this.currentPromise.then(_ => this)
    }

}

/** Creates a new bootstrap for OBL */
export function bootstrap(options?: BootstrapOptions): OBLBootstrap {
    return new OBLBootstrap(options ? options : DEFAULT_OPTIONS)
}