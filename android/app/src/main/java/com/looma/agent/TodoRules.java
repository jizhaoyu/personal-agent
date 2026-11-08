package com.looma.agent;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.DateTimeException;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure rules shared by persistence and the alarm receiver; testable without Android. */
public final class TodoRules {
    private static final Set<String> FIELDS = new HashSet<>(Arrays.asList(
            "id", "space", "title", "status", "createdAt", "updatedAt", "revision", "dueAt",
            "dueDate", "needsTime", "completedAt", "notifiedRevision", "lastNotifiedAt", "sourceText",
            "sourceKind", "sourceTaskId", "sourceFingerprint", "sourceDone"));
    private TodoRules() {}

    private static final Pattern ISO = Pattern.compile("^([0-9]{4}-[0-9]{2}-[0-9]{2})T([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\\.([0-9]+))?)?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$");

    private static void finite(Object value, String key) {
        if (!(value instanceof Number) || !Double.isFinite(((Number) value).doubleValue()))
            throw new IllegalArgumentException("无效待办时间字段: " + key);
    }

    private static String string(Map<String, Object> todo, String key, boolean nonempty) {
        Object value = todo.get(key);
        if (!(value instanceof String) || (nonempty && ((String) value).trim().isEmpty()))
            throw new IllegalArgumentException("无效待办字段: " + key);
        return (String) value;
    }

    public static long integer(Object value, String key, long minimum) {
        if (!(value instanceof Number)) throw new IllegalArgumentException("无效待办数字字段: " + key);
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < minimum || number > 9007199254740991L || number != Math.floor(number))
            throw new IllegalArgumentException("无效待办整数字段: " + key);
        return ((Number) value).longValue();
    }

    public static void validateRecord(Map<String, Object> todo) {
        for (String key : todo.keySet()) if (!FIELDS.contains(key)) throw new IllegalArgumentException("未知待办字段: " + key);
        if (string(todo, "id", true).length() > 200) throw new IllegalArgumentException("待办 id 过长");
        if (!Arrays.asList("life", "work").contains(string(todo, "space", true))) throw new IllegalArgumentException("无效待办空间");
        if (string(todo, "title", true).length() > 500) throw new IllegalArgumentException("待办标题过长");
        if (!Arrays.asList("suggested", "pending", "completed", "cancelled").contains(string(todo, "status", true)))
            throw new IllegalArgumentException("无效待办状态");
        finite(todo.get("createdAt"), "createdAt");
        finite(todo.get("updatedAt"), "updatedAt");
        long revision = integer(todo.get("revision"), "revision", 1);
        for (String key : Arrays.asList("completedAt", "lastNotifiedAt")) if (todo.containsKey(key)) finite(todo.get(key), key);
        if (todo.containsKey("notifiedRevision") && integer(todo.get("notifiedRevision"), "notifiedRevision", 1) > revision)
            throw new IllegalArgumentException("提醒版本超过记录版本");
        if (todo.containsKey("dueAt")) parseDueAt(string(todo, "dueAt", true));
        if (todo.containsKey("dueDate")) checkDueDate(string(todo, "dueDate", true));
        if (todo.containsKey("sourceText") && string(todo, "sourceText", false).length() > 12000)
            throw new IllegalArgumentException("待办来源原文过长");
        if (todo.containsKey("sourceTaskId")) {
            String sourceId = string(todo, "sourceTaskId", false);
            if (sourceId.isEmpty() || sourceId.length() > 200) throw new IllegalArgumentException("无效待办来源 id");
        }
        if (todo.containsKey("sourceFingerprint") && string(todo, "sourceFingerprint", false).length() > 2000)
            throw new IllegalArgumentException("待办来源指纹过长");
        if (todo.containsKey("sourceKind") && !Arrays.asList("task", "followup").contains(string(todo, "sourceKind", true)))
            throw new IllegalArgumentException("无效待办来源类型");
        for (String key : Arrays.asList("needsTime", "sourceDone")) {
            if (todo.containsKey(key) && !(todo.get(key) instanceof Boolean)) throw new IllegalArgumentException("无效待办布尔字段: " + key);
        }
    }

    public static void checkRevision(Long current, Long expected, long next) {
        if (current == null) {
            if (expected != null || next != 1) throw new IllegalArgumentException("新增待办必须使用空 expectedRevision 和 revision 1");
        } else if (!current.equals(expected) || next != current + 1) {
            throw new IllegalArgumentException("待办版本冲突，请刷新后重试");
        }
    }

    public static long parseDueAt(String value) {
        try {
            Matcher match = ISO.matcher(value);
            if (!match.matches()) throw new IllegalArgumentException("ISO");
            LocalDate date = LocalDate.parse(match.group(1), DateTimeFormatter.ISO_LOCAL_DATE.withResolverStyle(ResolverStyle.STRICT));
            String fraction = match.group(5) == null ? "" : match.group(5);
            int nano = fraction.isEmpty() ? 0 : Integer.parseInt((fraction + "000000000").substring(0, 9));
            LocalDateTime local = date.atTime(Integer.parseInt(match.group(2)), Integer.parseInt(match.group(3)),
                    match.group(4) == null ? 0 : Integer.parseInt(match.group(4)), nano);
            int offsetMinutes = "Z".equals(match.group(6)) ? 0 :
                    (Integer.parseInt(match.group(8)) * 60 + Integer.parseInt(match.group(9))) * ("-".equals(match.group(7)) ? -1 : 1);
            return local.toInstant(ZoneOffset.UTC).toEpochMilli() - offsetMinutes * 60000L;
        } catch (DateTimeException | ArithmeticException | IllegalArgumentException e) {
            throw new IllegalArgumentException("dueAt 必须是带时区的有效 ISO 日期时间");
        }
    }

    public static void checkDueDate(String value) {
        try {
            if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw new DateTimeParseException("date", value, 0);
            LocalDate.parse(value, DateTimeFormatter.ISO_LOCAL_DATE.withResolverStyle(ResolverStyle.STRICT));
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("dueDate 必须是有效 YYYY-MM-DD 日期");
        }
    }

    /** Match desktop copy and keep raw storage timestamps out of notifications. */
    public static String notificationBody(String dueAt, long now) {
        long due = parseDueAt(dueAt);
        ZoneId shanghai = ZoneId.of("Asia/Shanghai");
        LocalDateTime target = LocalDateTime.ofInstant(Instant.ofEpochMilli(due), shanghai);
        LocalDate today = Instant.ofEpochMilli(now).atZone(shanghai).toLocalDate();
        LocalDate date = target.toLocalDate();
        String day = date.equals(today) ? "今天" : date.equals(today.minusDays(1)) ? "昨天"
                : (date.getYear() == today.getYear() ? "" : date.getYear() + "年")
                    + date.getMonthValue() + "月" + date.getDayOfMonth() + "日";
        String lead = now - due >= 60000L ? "这条待办还没完成 · 原定" : "提醒时间到了 · ";
        return lead + day + " " + target.format(DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT));
    }

    public static boolean shouldNotify(String status, long revision, long notifiedRevision,
                                       long alarmRevision, long dueAt, long now) {
        return "pending".equals(status) && revision == alarmRevision
                && notifiedRevision != revision && dueAt <= now;
    }
}
