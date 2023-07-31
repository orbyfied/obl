import * as obl from './index'

const bot = obl.bootstrap()
bot.requireDefaults()
    .requireAll("./services")
    .requireAll("./modules")
    .createClient({ intents: [] })
    .loadAll()
    .login("myToken")