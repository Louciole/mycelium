package dev.carbonlab.mycelium.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.graphics.drawable.IconCompat;

import java.net.URL;
import java.util.Map;

/**
 * Builds the notifications shown for incoming pushes and for the user's own
 * inline replies. Centralised so the messaging service and the reply receiver
 * render conversations identically.
 *
 * Direct messages use {@link NotificationCompat.MessagingStyle} keyed by a
 * stable per-conversation id, so successive messages (and the user's replies)
 * stack into a single conversation thread instead of piling up.
 */
final class NotificationHelper {

    static final String GROUP_MESSAGES = "mycelium_messages";
    static final int COLOR = 0xFF6C63FF;

    private NotificationHelper() {
    }

    /**
     * Stable notification id per place so messages thread together. A DM and a
     * channel can share the same numeric id (different tables), so channels are
     * namespaced with the serverId to avoid collisions.
     */
    static int idFor(String convId, String serverId) {
        if (convId == null) {
            return "misc".hashCode();
        }
        String key = (serverId != null) ? ("chan:" + serverId + ":" + convId) : ("conv:" + convId);
        return key.hashCode();
    }

    /** Post a notification for an incoming push message. */
    static void showIncoming(Context ctx, Map<String, String> data) {
        String type = data.get("type");
        String convId = data.get("convId");
        String serverId = data.get("serverId");
        String groupTitle = data.get("groupTitle");
        String title = orDefault(data.get("title"), "Mycelium");
        String body = orDefault(data.get("body"), "");

        boolean isMessage = "message".equals(type) && convId != null;
        String channelId = "call".equals(type) ? "calls" : "messages";
        ensureChannel(ctx, channelId);

        int notifId = idFor(convId, serverId);
        NotificationCompat.Builder b = baseBuilder(ctx, channelId, data, notifId, isMessage);

        if (isMessage) {
            NotificationCompat.MessagingStyle style = existingStyle(ctx, notifId);
            if (style == null) {
                style = new NotificationCompat.MessagingStyle(self(ctx));
            }
            // A channel post is a group conversation titled with the channel name.
            if (groupTitle != null) {
                style.setConversationTitle(groupTitle);
                style.setGroupConversation(true);
            }
            Person sender = buildSender(title, convId, data.get("avatarUrl"));
            style.addMessage(body, System.currentTimeMillis(), sender);
            b.setStyle(style);
        } else {
            b.setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        }

        notify(ctx, notifId, b);
    }

    /** Optimistically append the user's reply to the conversation thread. */
    static void appendOwnReply(Context ctx, Map<String, String> data, int notifId, String text) {
        ensureChannel(ctx, "messages");
        NotificationCompat.MessagingStyle style = existingStyle(ctx, notifId);
        if (style == null) {
            style = new NotificationCompat.MessagingStyle(self(ctx));
        }
        style.addMessage(text, System.currentTimeMillis(), (Person) null); // null sender = "you"

        NotificationCompat.Builder b = baseBuilder(ctx, "messages", data, notifId, true)
                .setStyle(style)
                .setOnlyAlertOnce(true); // our own reply shouldn't buzz again
        notify(ctx, notifId, b);
    }

    /** Re-show the conversation with a clear "not delivered" hint when the send failed. */
    static void markReplyFailed(Context ctx, Map<String, String> data, int notifId, String text) {
        ensureChannel(ctx, "messages");
        NotificationCompat.MessagingStyle style = existingStyle(ctx, notifId);
        if (style == null) {
            style = new NotificationCompat.MessagingStyle(self(ctx));
            style.addMessage(text, System.currentTimeMillis(), (Person) null);
        }
        NotificationCompat.Builder b = baseBuilder(ctx, "messages", data, notifId, true)
                .setStyle(style)
                .setOnlyAlertOnce(true)
                .setSubText(ctx.getString(R.string.notif_reply_failed));
        notify(ctx, notifId, b);
    }

    private static Person buildSender(String name, String convId, String avatarUrl) {
        Person.Builder builder = new Person.Builder().setName(name).setKey("peer:" + convId);
        if (avatarUrl != null && !avatarUrl.isEmpty()) {
            try {
                Bitmap bmp = BitmapFactory.decodeStream(new URL(avatarUrl).openStream());
                if (bmp != null) builder.setIcon(IconCompat.createWithBitmap(bmp));
            } catch (Exception ignored) {}
        }
        return builder.build();
    }

    // ----------------------------------------------------------------- internals

    private static NotificationCompat.Builder baseBuilder(Context ctx, String channelId,
            Map<String, String> data, int notifId, boolean withReply) {
        int icon = ctx.getResources().getIdentifier("ic_stat_mycelium", "drawable", ctx.getPackageName());

        PendingIntent contentPI = PendingIntent.getActivity(
                ctx, notifId, contentIntent(ctx, data),
                PendingIntent.FLAG_UPDATE_CURRENT | flagImmutable());

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(icon)
                .setColor(COLOR)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setGroup(GROUP_MESSAGES)
                .setContentIntent(contentPI)
                .setPriority(NotificationCompat.PRIORITY_HIGH);

        if (withReply && data.get("convId") != null) {
            RemoteInput remoteInput = new RemoteInput.Builder(MyceliumMessagingService.REPLY_KEY)
                    .setLabel(ctx.getString(R.string.notif_reply))
                    .build();

            Intent replyIntent = new Intent(ctx, NotificationReplyReceiver.class)
                    .setAction(MyceliumMessagingService.ACTION_REPLY)
                    .putExtra(MyceliumMessagingService.EXTRA_CONV_ID, data.get("convId"))
                    .putExtra(MyceliumMessagingService.EXTRA_SERVER_ID, data.get("serverId"))
                    .putExtra(MyceliumMessagingService.EXTRA_NOTIF_ID, notifId);

            PendingIntent replyPI = PendingIntent.getBroadcast(
                    ctx, notifId, replyIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | flagMutable());

            b.addAction(new NotificationCompat.Action.Builder(icon, ctx.getString(R.string.notif_reply), replyPI)
                    .addRemoteInput(remoteInput)
                    .setAllowGeneratedReplies(true)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setShowsUserInterface(false)
                    .build());
        }
        return b;
    }

    private static Intent contentIntent(Context ctx, Map<String, String> data) {
        String convId = data.get("convId");
        String serverId = data.get("serverId");
        String channelType = data.get("channelType");
        String channelId = data.get("channelId");
        Uri uri = null;
        if (serverId != null && channelType != null && channelId != null) {
            // Channel post → the channel's route in the web app (<server>/<type>/<id>);
            // for a vocal channel, with its text chat open.
            uri = Uri.parse("mycelium://channel/" + serverId + "/" + channelType + "/" + channelId
                    + ("vocal".equals(channelType) ? "/chat" : ""));
        } else if (convId != null) {
            // Direct message → open the conversation.
            uri = Uri.parse("mycelium://conv/" + convId);
        }
        Intent intent = (uri != null)
                ? new Intent(Intent.ACTION_VIEW, uri).setPackage(ctx.getPackageName())
                : new Intent(ctx, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    private static NotificationCompat.MessagingStyle existingStyle(Context ctx, int notifId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return null;
        }
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) {
            return null;
        }
        for (StatusBarNotification sbn : nm.getActiveNotifications()) {
            if (sbn.getId() == notifId) {
                return NotificationCompat.MessagingStyle
                        .extractMessagingStyleFromNotification(sbn.getNotification());
            }
        }
        return null;
    }

    private static Person self(Context ctx) {
        return new Person.Builder().setName(ctx.getString(R.string.notif_you)).setKey("self").build();
    }

    private static void notify(Context ctx, int notifId, NotificationCompat.Builder b) {
        try {
            NotificationManagerCompat.from(ctx).notify(notifId, b.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS not granted (Android 13+).
        }
    }

    private static void ensureChannel(Context ctx, String channelId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(channelId) != null) {
            return;
        }
        boolean isCall = "calls".equals(channelId);
        NotificationChannel ch = new NotificationChannel(
                channelId,
                isCall ? "Calls" : "Messages",
                isCall ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(ch);
    }

    private static String orDefault(String value, String fallback) {
        return value == null ? fallback : value;
    }

    private static int flagImmutable() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0;
    }

    private static int flagMutable() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
    }
}
