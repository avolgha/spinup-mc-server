#!/usr/bin/env node
import cp from "child_process";
import enquirer from "enquirer";
import fs from "fs";
import http from "https";
import path from "path";

type Version = keyof typeof servers;
type Mutable<T extends readonly unknown[]> = {
    -readonly [K in keyof T]: T[K];
};

const serverPortRegex = /server-port=(?<port>\d+)/g;
const servers = {
    "1.21.1":
        "https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/132/downloads/paper-1.21.1-132.jar",
} as const;

// This has to be hacked in this ugly way because as const returns
// an immutable array, which we cannot allow to happen for the future
// process of this script.
const actions = (() => {
    const result = [
        "Quit",
        "Start",
        "Remove",
        "Install Plugin",
        "Update Plugin",
        "Remove Plugin",
        "Set Port",
    ] as const;

    return result as Mutable<typeof result>;
})();

function isValidHttpUrl(input: string) {
    try {
        const url = new URL(input);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch (_) {
        return false;
    }
}

function extractFilenameFromUrl(url: string) {
    return url.substring(url.lastIndexOf("/"));
}

function downloadFileTo(url: string, destination: string, debug = true) {
    return new Promise<void>((res, rej) => {
        const writeStream = fs.createWriteStream(destination);

        debug && console.log("Downloading", url);

        http.get(url, (response) => {
            response.pipe(writeStream);

            writeStream.on("finish", () => {
                writeStream.close();
                debug && console.log("Download completed!");
                res();
            });

            writeStream.on("error", (error) => {
                writeStream.close();
                debug && console.log("Download failed!");
                rej(error);
            });
        });
    });
}

async function downloadOrMove(supposedPath: string, destinationDir: string) {
    if (isValidHttpUrl(supposedPath)) {
        await downloadFileTo(
            supposedPath,
            path.join(destinationDir, extractFilenameFromUrl(supposedPath))
        );
        return;
    }

    if (!fs.existsSync(supposedPath)) {
        console.error(
            `The given file does not exist on your system. (${supposedPath})`
        );
        return;
    }

    fs.copyFileSync(
        supposedPath,
        path.join(destinationDir, path.basename(supposedPath))
    );
}

function exec(
    command: string,
    options: {
        cwd?: string;
        passStdin?: boolean;
        stdoutPrefix?: string;
        stderrPrefix?: string;
    } = {}
) {
    const split = command.split(" ");
    const useStdin = options.passStdin || true;
    return new Promise<void>((res, rej) => {
        const proc = cp.spawn(split.shift()!, split, {
            cwd: options.cwd || undefined,
        });

        useStdin && process.stdin.pipe(proc.stdin);

        proc.stdout.on("data", (data) => {
            options.stdoutPrefix && process.stdout.write(options.stdoutPrefix);
            process.stdout.write(data);
        });

        proc.stderr.on("data", (data) => {
            options.stderrPrefix && process.stderr.write(options.stderrPrefix);
            process.stderr.write(data);
        });

        proc.on("close", () => {
            useStdin && process.stdin.unpipe(proc.stdin);
            res();
        });

        proc.on("error", (error) => rej(error));
    });
}

const workingDir = path.join("F:", "servers");
if (!fs.existsSync(workingDir)) {
    console.log("Creating servers directory...");
    fs.mkdirSync(workingDir);
}

const results = await enquirer.prompt<{ version: Version }>({
    type: "select",
    name: "version",
    message: "Which version should be launched?",
    choices: Object.keys(servers),
});

const serverDir = path.join(workingDir, results.version);
const pluginsFolder = path.join(serverDir, "plugins");
if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir);

    const jarUrl = servers[results.version]!;
    await downloadFileTo(jarUrl, path.join(serverDir, "server.jar"));

    await exec("java -jar server.jar", {
        cwd: serverDir,
        stderrPrefix: "[err] ",
        stdoutPrefix: "[out] ",
    });

    const eulaFile = path.join(serverDir, "eula.txt");
    const oldEula = fs.readFileSync(eulaFile, "utf-8");
    fs.writeFileSync(eulaFile, oldEula.slice(0, -7) + "true\r\n");

    console.log("Server setup finished!");
}

while (true) {
    const { action } = await enquirer.prompt<{
        action: (typeof actions)[number];
    }>({
        type: "select",
        name: "action",
        message: "Which action do you want to perform?",
        choices: actions as any,
    });

    switch (action) {
        case "Quit":
            process.exit(0);

        case "Start":
            console.clear();

            await exec("java -jar server.jar -nogui", {
                cwd: serverDir,
            });

            break;

        case "Remove":
            const { confirm } = await enquirer.prompt<{ confirm: boolean }>({
                type: "confirm",
                name: "cornfirm",
                message: "Do you really want to remove the server?",
            });

            if (confirm === true) {
                fs.rmSync(serverDir, { recursive: true, force: true });
                process.exit(0);
            }

            break;

        case "Install Plugin": {
            const { url } = await enquirer.prompt<{ url: string }>({
                type: "input",
                name: "url",
                message: "Where is your plugin located? (URL or File path)",
            });

            await downloadOrMove(url, pluginsFolder);

            break;
        }

        case "Update Plugin": {
            const installedPlugins = fs
                .readdirSync(pluginsFolder)
                .filter(
                    (entry) =>
                        fs.statSync(path.join(pluginsFolder, entry)).isFile() &&
                        entry.endsWith(".jar")
                );

            if (installedPlugins.length < 1) {
                console.warn("There are no plugins installed.");
                break;
            }

            const { plugin, url } = await enquirer.prompt<{
                plugin: string;
                url: string;
            }>([
                {
                    type: "select",
                    name: "plugin",
                    message: "Which plugin should be updated?",
                    choices: installedPlugins,
                },
                {
                    type: "input",
                    name: "url",
                    message: "Where is your plugin located? (URL or File path)",
                },
            ]);

            console.log("Updating", plugin);
            fs.rmSync(path.join(pluginsFolder, plugin));

            await downloadOrMove(url, pluginsFolder);

            break;
        }

        case "Remove Plugin":
            const installedPlugins = fs
                .readdirSync(pluginsFolder)
                .filter(
                    (entry) =>
                        fs.statSync(path.join(pluginsFolder, entry)).isFile() &&
                        entry.endsWith(".jar")
                );

            if (installedPlugins.length < 1) {
                console.warn("There are no plugins installed.");
                break;
            }

            const { plugins } = await enquirer.prompt<{ plugins: string[] }>({
                type: "multiselect",
                name: "plugins",
                message: "Which plugins should be removed?",
                choices: installedPlugins,
            });

            for (const plugin of plugins) {
                console.log("Removing", plugin);
                const pluginPath = path.join(pluginsFolder, plugin);
                fs.rmSync(pluginPath);
            }

            break;

        case "Set Port":
            const propertiesFile = path.join(serverDir, "server.properties");
            if (!fs.existsSync(propertiesFile)) {
                console.error(
                    "Please start the server at least one time first to modify the port!"
                );
                break;
            }

            let propertiesRaw = fs.readFileSync(propertiesFile, "utf-8");
            const portMatches = serverPortRegex.exec(propertiesRaw);
            if (!portMatches || !portMatches.groups) {
                console.error(
                    "Malformed server.properties file. Cannot process."
                );
                break;
            }

            const oldPort = parseInt(portMatches.groups.port);
            const { newPort } = await enquirer.prompt<{ newPort: number }>({
                type: "numeral",
                name: "newPort",
                message: "What should be the new port?",
                initial: oldPort,
                validate(value) {
                    try {
                        const port = parseInt(value);
                        return port >= 0 && port <= 65535
                            ? true
                            : "Port must be a positive integer lower than 65536";
                    } catch (error) {
                        return error instanceof Error
                            ? `[${error.name}] ${error.message}`
                            : (error as string);
                    }
                },
            });

            propertiesRaw = propertiesRaw.replace(
                serverPortRegex,
                `server-port=${newPort}`
            );

            fs.writeFileSync(propertiesFile, propertiesRaw, "utf-8");

            break;
    }
}
