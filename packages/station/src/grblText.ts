// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** GRBL 1.1 error codes in words (the ones a station meets). */
const ERRORS: Record<number, string> = {
    1: "в строке нет буквы команды",
    2: "неверное число в строке",
    3: "контроллер не знает такой $-команды",
    5: "поиск нуля (Домой) выключен в контроллере: нет концевиков или $22=0",
    8: "команда не выполняется, пока станок занят",
    9: "станок в тревоге или заблокирован — сначала «Разблокировать»",
    15: "перемещение за пределы рабочего поля",
    16: "неверная команда перемещения",
    20: "неизвестная или неподдерживаемая G-команда",
    22: "не задана подача F",
    24: "две команды, которым нужны оси, в одной строке",
    33: "неверная цель перемещения (дуга или G-команда)",
};

/** "error:5 $H" → "Домой: поиск нуля выключен…"; unknown codes stay as GRBL wrote them. */
export function grblErrorText(error: string): string {
    const m = /^error:(\d+)\s*(.*)$/.exec(error);
    if (!m) return error;
    const text = ERRORS[Number(m[1])];
    if (!text) return `${error}`;
    const line = m[2].trim();
    const what = line === "$H" ? "Домой" : line === "$X" ? "Разблокировать" : line;
    return what ? `${what}: ${text} (error:${m[1]})` : `${text} (error:${m[1]})`;
}
