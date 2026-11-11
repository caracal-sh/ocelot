import Foundation

// `ocelot`: see Subcommand.swift for how commands are registered.

func ocelotMain(_ arguments: [String]) -> Int32 {
    guard let first = arguments.first else {
        Console.out(SubcommandRegistry.help)
        return 0
    }
    if ["-h", "--help", "help"].contains(first) {
        if first == "help", let name = arguments.dropFirst().first, let command = SubcommandRegistry.find(name) {
            Console.out(command.usage)
        } else {
            Console.out(SubcommandRegistry.help)
        }
        return 0
    }
    if ["-v", "--version", "version"].contains(first) {
        Console.out("ocelot \(CLIInfo.version)")
        return 0
    }
    guard let command = SubcommandRegistry.find(first) else {
        Console.err("ocelot: unknown command \"\(first)\". Commands: \(SubcommandRegistry.all.map { $0.name }.joined(separator: ", ")). Run `ocelot help`.")
        return 2
    }
    let rest = Array(arguments.dropFirst())
    if rest.contains("--help") || rest.contains("-h") {
        Console.out(command.usage)
        return 0
    }
    do {
        return try command.run(rest)
    } catch let error as CLIError {
        Console.err("ocelot: \(error.message)")
        return error.code
    } catch {
        Console.err("ocelot: \(error)")
        return 1
    }
}

exit(ocelotMain(Array(CommandLine.arguments.dropFirst())))
