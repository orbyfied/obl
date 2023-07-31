import readline from 'readline'
import { ServiceManager } from './services';

/** Run the console */
export async function openConsole(services: ServiceManager) {
    // setup console reader
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    // main console loop
    let exit = false
    while (!exit) {
        try {
            // wait for new line
            let line = await new Promise((resolve, reject) => {
                rl.once('line', resolve)
                rl.once('close', () => reject("closed"))
            })

            // quit command
            if (line == 'q') {
                exit = true
            }
        } catch (e) { }
    }

    // exit process
    process.exit(0)
}