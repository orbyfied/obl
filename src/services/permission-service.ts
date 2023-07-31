import { Client, GatewayIntentBits, GuildMember, Role } from "discord.js"
import { BotService, InjectStage, ServiceManager, autoRegister, dependency, discordEventHandler, eventHandler, providedBy, provides } from "../services"
import { Result, pcallAsync } from "../util/result"
import { DataIO, fileJsonIO } from "../util/io"

export enum Permit {
    NONE  =  0,
    ALLOW =  1,
    DENY  = -1
}

export class FlatPermissionNode {
    name: string   // The full path of this node
    permit: Permit // The permit status 
}

/** Represents a permission node */
export class PermissionNode {
    constructor(parent: PermissionNode, name: string) {
        this.parent = parent
        this.name = name
        this.children = new Map()
    }
    
    parent: PermissionNode                // The parent of this node
    name: string                          // The name of this permission node
    permit: Permit = Permit.NONE          // The permit status of this node
    children: Map<string, PermissionNode> // The children of this node by name

    /** Clear this node's data */
    public clear() {
        this.permit = Permit.NONE
        this.children.clear()
    }

    /** Check whether this node is the root node */
    public isRoot(): boolean {
        return this.parent == null
    }

    /** Set the permit on this node */
    public withPermit(permit: Permit): PermissionNode {
        this.permit = permit
        return this
    }

    /** Add a child node to the map */
    public then(node: PermissionNode): PermissionNode {
        this.children.set(node.name, node)
        node.parent = this
        return this
    }

    // Internal: flatten the nodes or some shit idk what im doing
    private flatten0(list: FlatPermissionNode[], currentPath: string) {
        // check if a permit is set
        // if so add this node to the list
        if (this.permit != undefined && this.permit != Permit.NONE) {
            list.push({ name: currentPath, permit: this.permit })
        }

        // append children
        this.children.forEach(n => n.flatten0(list, currentPath + "." + n.name))
    }

    /** Flatten this node tree into an array of flat nodes */
    public flatten(list: FlatPermissionNode[] = []): FlatPermissionNode[] {
        this.flatten0(list, "*")
        return list
    }

    /** Unflatten and register the given list of flat nodes */
    public unflatten(list: FlatPermissionNode[]) {
        for (let flatNode of list) {
            this.set(flatNode.name, flatNode.permit)
        }
    }

    /** Set the given permission to the given permit,
     *  returns the last node in the chain */
    public set(path: string[] | string, permit: Permit): PermissionNode {
        if (typeof path == 'string')
            path = path.split(".")

        let current: PermissionNode = this
        for (let part of path) {
            if (part == '*') continue

            // get or create next node
            let oldCurrent = current
            current = current.children.get(part)
            if (!current) {
                oldCurrent.then(current = new PermissionNode(oldCurrent, part))
            }
        }

        // set permit
        return current.withPermit(permit)
    }

    /** Check the given permission path */
    public check(path: string[] | string, def: Permit = Permit.DENY): Permit {
        if (typeof path == 'string')
            path = path.split(".")

        let result = def
        let current: PermissionNode = this
        for (let s of path) {
            // check permit
            if (current.permit != Permit.NONE) {
                result = current.permit
            }

            if (s == '*') continue

            // get child node
            current = current.children.get(s)
            if (!current) {
                // end of set permissions,
                // return current result
                break
            }
        }

        return result
    }
}

function newBaseNode(): PermissionNode {
    return new PermissionNode(null, null)
}

export function permit(name: string, permit: Permit) {
    return new PermissionNode(null, name).withPermit(permit)
}

export function allow(name: string) {
    return permit(name, Permit.ALLOW)
}

export function deny(name: string) {
    return permit(name, Permit.DENY)
}

export function unchanged(name: string) {
    return permit(name, Permit.NONE)
}

/** An object which can have permissions associated with it */
export abstract class Permissible {
    protected manager: PermissionManager // The permission manager

    constructor(manager: PermissionManager) {
        this.manager = manager
    }

    /** Check for the given permission */
    abstract check(permission: string[] | string, def: Permit): Permit

    /** Check for the given permission asynchronously */
    checkAsync(permission: string[] | string, def: Permit): Promise<Result<Permit>> {
        return pcallAsync<Permit>(this.check, this, permission, def)
    }

    /** Called when the properties of this permissible are modified,
     *  should ALWAYS call super.invalidateCaches() if possible */
    invalidateCaches() { }
}

/** Represents a permissible which gets it's permission from inherited groups */
export abstract class GroupBasedPermissible extends Permissible {
    constructor(manager: PermissionManager) {
        super(manager)
    }

    /** Get the groups this permissible inherits from */
    abstract groups(): PermissionGroup[]

    check(permission: string | string[], def: Permit): Permit {
        let result: Permit

        // check inherited permissibles
        for (let i of this.groups()) {
            result = i.check(permission, Permit.NONE)
            if (result) {
                return result
            }
        }

        // return default
        return def
    }
}

/** An object capable of calculating and holding custom permissions */
export abstract class PermissionObject extends Permissible {
    constructor(manager: PermissionManager) {
        super(manager)
    }

    private readonly baseNode: PermissionNode = newBaseNode()  // The base permission node
    private readonly inherits: Permissible[] = []              // The holders this object inherits from, should be sorted from high to low
    private cacheNode: PermissionNode                          // The cached permission node, caching inherited values

    /** Get the identifier for the permission holder */
    abstract id(): string

    /** Check/get the given permission value */
    override check(permission: string[] | string, def: Permit): Permit {
        if (typeof permission == 'string')
            permission = permission.split(".")

        // check this objects data
        let result = this.baseNode.check(permission, Permit.NONE)
        if (result) {
            return result
        }

        // check cached data
        if (this.cacheNode) {
            result = this.cacheNode.check(permission, Permit.NONE)
            if (result) {
                return result
            }
        }

        // check inherited permissibles
        for (let i of this.inherits) {
            result = i.check(permission, Permit.NONE)
            if (result) {
                this.cacheNode.set(permission, result)
                return result
            }
        }

        // return default
        return def
    }

    /** Set the given permission to the given value
     *  ALWAYS call this, as it invalidates caches automatically */
    public set(permission: string | string[], permit: Permit): this {
        this.baseNode.set(permission, permit)
        this.invalidateCaches()
        return this
    }

    /** Add the given permissible as an object to be inherited from */
    public addInherits(permissible: Permissible): this {
        this.inherits.push(permissible)
        this.invalidateCaches()
        return this
    }

    /** Removes the given permissible as an object to be inherited from */
    public removeInherits(permissible: Permissible): this {
        this.inherits.splice(this.inherits.indexOf(permissible), 1)
        this.invalidateCaches()
        return this
    }

    /** Enable/disable caching on this object */
    public setCaching(b: boolean): this {
        this.cacheNode = b ? newBaseNode() : undefined
        return this
    }

    /** Save this holders data to the given object */
    save(to: any) {
        to.permissions = this.baseNode.flatten()
    }

    /** Load data from the given object into this holder */
    load(from: any) {
        this.baseNode.unflatten(from.permissions)
        this.invalidateCaches()
    }

    invalidateCaches(): void {
        super.invalidateCaches()
        if (this.cacheNode) {
            this.cacheNode.clear()
        }
    }
}

/** A permission holder which other groups and users can inherit */
export class PermissionGroup extends PermissionObject {
    readonly name: string // The name of the permission group

    constructor(manager: PermissionManager, name: string) {
        super(manager)
        this.name = name
    }

    override id(): string {
        return this.name
    }

    load(from: any): void {
        super.load(from)
    }

    save(to: any): void {
        super.save(to)
    }
}

/** A permission group connected to a role */
export class RoleBasedPermissionGroup extends PermissionGroup {
    constructor(manager: PermissionManager, name: string) {
        super(manager, name)
    }

    roleId: string // The ID for the role this group is based on
    role: Role     // The cached role for this group

    load(from: any): void {
        super.load(from)
        this.roleId = from.roleId
    }

    save(to: any): void {
        super.save(to)
        to.roleId = this.roleId
    }
}

function memberPermissibleKey(member: GuildMember): string {
    return member.guild.id + "." + member.id
}

/** The manager of all permission related data */
@providedBy("PermissionService", "service")
export class PermissionManager {
    private static INSTANCE: PermissionManager
    public static get(): PermissionManager {
        return this.INSTANCE
    }
    
    constructor() {
        PermissionManager.INSTANCE = this
    }

    dataIO: DataIO                                                  // The data IO provider to use

    groups: PermissionGroup[] = []                                  // All registered groups
    groupsByName: Map<string, PermissionGroup> = new Map()          // All registered groups by name
    groupsByRole: Map<string, RoleBasedPermissionGroup> = new Map() // All registered role based groups by role ID

    memberPermissibleCache: Map<string, Permissible> = new Map()    // User permissible cache

    /**
     * Register the given group to the permission manager
     * @param group The group to register
     */
    registerGroup(group: PermissionGroup) {
        this.groups.push(group)
        this.groupsByName.set(group.id(), group)

        if (group instanceof RoleBasedPermissionGroup) {
            this.groupsByRole.set(group.roleId, group)
        }
    }

    /**
     * Get a mirror permissible for the given member
     * @param user The member
     */
    forMember(member: GuildMember): Permissible {
        let key = memberPermissibleKey(member)

        let permissible = this.memberPermissibleCache.get(key)
        if (permissible)
            return permissible

        this.memberPermissibleCache.set(key, permissible = new DiscordMemberPermissible(this, member))
        return permissible
    } 

    /** Loads all persistent data (synchronous) */
    loadAllPersistentData() {
        let data = this.dataIO.load()

        /// Groups
        let groupList: any[] = data.groups || []
        groupList.forEach(gr /* group raw data */ => {
            let name = gr.name
            let group = gr.roleId ? new RoleBasedPermissionGroup(this, name) : new PermissionGroup(this, name)
            group.load(gr)
            this.registerGroup(group)
        })
    }

    /** Saves all persistent data */
    async saveAllPersistentData() {
        let data = { } as any

        /// Groups
        let groupList = (data.groups = [])
        this.groups.forEach(g => {
            let gr = { name: g.name } as any
            g.save(gr)
            groupList.push(gr)
        })

        this.dataIO.save(data)
    }
}

export class DiscordMemberPermissible extends GroupBasedPermissible {
    member: GuildMember                // The guild member
    groupCache: PermissionGroup[]      // The cached list of groups

    constructor(manager: PermissionManager, member: GuildMember) {
        super(manager)
        this.member = member
    }

    groups(): PermissionGroup[] {
        if (this.groupCache) {
            return this.groupCache
        }

        let list = []
        for (let role of this.member.roles.cache) {
            let group = this.manager.groupsByRole.get(role[0])
            if (group) {
                list.push(group)
            }
        }
        
        this.groupCache = list
        return list
    }
    
    invalidateCaches() {
        super.invalidateCaches()
        this.groupCache = undefined
    }
}

@autoRegister()
export class PermissionService extends BotService {
    readonly requiredDiscordIntents = [ GatewayIntentBits.GuildMembers ]

    @provides(PermissionManager)
    permissionManager: PermissionManager // The permission manager

    @dependency(Client, InjectStage.Ready)
    client: Client

    onLoad(manager: ServiceManager): void {
        this.permissionManager = new PermissionManager()
        this.logger.info("Loading persistent permission data")
        this.permissionManager.dataIO = fileJsonIO("permission-service/data.json")
        this.permissionManager.loadAllPersistentData()
    }

    @eventHandler("saveData")
    async save(p: any) {
        if (p.reason != 'autosave-interval') {
            this.logger.info("Saving persistent permission data")
        }
        
        this.permissionManager.saveAllPersistentData()
    }

    onReady(manager: ServiceManager): void {
        this.client.on('guildMemberUpdate', (oldMember, member) => {
            // invalidate user' permissible
            let permissible = this.permissionManager.memberPermissibleCache.get(memberPermissibleKey(member))
            if (permissible) {
                permissible.invalidateCaches()
            }
        })
    }
}