export function filterClientInstanceTargets(targets, targetClientInstanceId) {
    const clients = [...targets];
    if (typeof targetClientInstanceId !== 'string' || !targetClientInstanceId) {
        return clients;
    }
    return clients.filter((client) => client?._clientInstanceId === targetClientInstanceId);
}
