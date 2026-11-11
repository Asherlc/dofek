import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import org.apache.bookkeeper.client.BookKeeper;
import org.apache.bookkeeper.client.BookKeeperAdmin;
import org.apache.bookkeeper.client.LedgerEntry;
import org.apache.bookkeeper.client.LedgerHandle;
import org.apache.bookkeeper.conf.ClientConfiguration;
import org.apache.bookkeeper.net.BookieId;

/** Synthetic, uncompressed/unencrypted official-client entries only; not an operator tool. */
public final class BookieEvacuationFixture {
    private static final Path MANIFEST = Path.of("/fixture/manifest.properties");
    private static final byte[] PASSWORD = "synthetic-fixture".getBytes(StandardCharsets.UTF_8);
    private static final int COUNT = 8;
    private static final String OLD = "source:3181";
    private static final String TARGET = "replacement:3181";
    private static final Properties state = new Properties();

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private static byte[] entry(String account, int index) {
        return (state.getProperty(account + "Marker") + ":" + index).getBytes(StandardCharsets.UTF_8);
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value & 255));
        return result.toString();
    }

    private static void save() throws Exception {
        try (OutputStream out = Files.newOutputStream(MANIFEST)) { state.store(out, "Synthetic ledgers"); }
    }

    private static void create(BookKeeper client, String name, boolean close) throws Exception {
        LedgerHandle ledger = client.createLedger(1, 1, 1, BookKeeper.DigestType.CRC32C, PASSWORD);
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        for (int index = 0; index < COUNT; index++) {
            byte[] bytes = entry(name.equals("a") ? "a" : "b", index);
            require(ledger.addEntry(bytes) == index, "Acknowledged entry ID mismatch");
            hash.update(bytes);
        }
        state.setProperty(name, Long.toString(ledger.getId()));
        state.setProperty(name + "Hash", hex(hash.digest()));
        if (close) ledger.close(); // open B deliberately remains metadata-open when the client disconnects.
        save();
    }

    private static void verify(BookKeeper client, BookKeeperAdmin admin, String member) throws Exception {
        Set<Long> expected = new HashSet<>();
        for (String name : List.of("closed", "open", "new")) {
            if (!state.containsKey(name)) continue;
            long id = Long.parseLong(state.getProperty(name));
            expected.add(id);
            try (LedgerHandle ledger = client.openLedgerNoRecovery(id, BookKeeper.DigestType.CRC32C, PASSWORD)) {
                boolean openSource = member.equals(OLD) && name.equals("open");
                require(ledger.getLedgerMetadata().isClosed() != openSource, "Unexpected ledger closed state: " + id);
                if (!openSource) require(ledger.getLastAddConfirmed() == COUNT - 1, "B LAC/count mismatch: " + id);
                require(ledger.getLedgerMetadata().getEnsembleSize() == 1
                    && ledger.getLedgerMetadata().getWriteQuorumSize() == 1
                    && ledger.getLedgerMetadata().getAckQuorumSize() == 1, "Quorum changed");
                for (List<BookieId> ensemble : ledger.getLedgerMetadata().getAllEnsembles().values()) {
                    require(ensemble.equals(List.of(BookieId.parse(member))), "Unexpected ensemble: " + ensemble);
                }
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                java.util.Enumeration<LedgerEntry> entries = ledger.readUnconfirmedEntries(0, COUNT - 1);
                int count = 0;
                while (entries.hasMoreElements()) {
                    LedgerEntry item = entries.nextElement();
                    require(item.getEntryId() == count, "Read entry ID mismatch");
                    byte[] bytes = item.getEntry();
                    require(Arrays.equals(bytes, entry("b", count)), "B payload mismatch: " + id);
                    hash.update(bytes);
                    count++;
                }
                require(count == COUNT && hex(hash.digest()).equals(state.getProperty(name + "Hash")),
                    "Full B hash/count mismatch: " + id);
                System.out.println("verified ledger=" + id + " count=" + count + " sha256=" + state.getProperty(name + "Hash"));
            }
        }
        Set<Long> actual = new HashSet<>();
        for (Long id : admin.listLedgers()) actual.add(id);
        require(actual.equals(expected), "Surviving ledger inventory differs: " + actual + " expected " + expected);
    }

    private static Set<String> identities(Collection<BookieId> ids) {
        Set<String> result = new HashSet<>();
        for (BookieId id : ids) result.add(id.toString());
        return result;
    }

    private static void scan(Path directory, boolean source) throws Exception {
        byte[] a = state.getProperty("aMarker").getBytes(StandardCharsets.UTF_8);
        byte[] b = state.getProperty("bMarker").getBytes(StandardCharsets.UTF_8);
        boolean foundA = false, foundB = false;
        int files = 0;
        try (var paths = Files.walk(directory)) {
            for (Path path : paths.filter(Files::isRegularFile).toList()) {
                String name = path.getFileName().toString();
                if (!name.endsWith(".txn") && !name.endsWith(".log")) continue;
                files++;
                // BK CRC32C adds only digest/header bytes; payloads stay contiguous in native journals/entry logs.
                // https://github.com/apache/bookkeeper/blob/release-4.18.2/bookkeeper-server/src/main/java/org/apache/bookkeeper/proto/checksum/DigestManager.java
                int overlap = Math.max(a.length, b.length) - 1;
                byte[] buffer = new byte[65536 + overlap];
                int retained = 0;
                try (InputStream in = Files.newInputStream(path)) {
                    int read;
                    while ((read = in.read(buffer, retained, 65536)) != -1) {
                        int length = retained + read;
                        for (int i = 0; i < length; i++) {
                            if (i + a.length <= length && Arrays.equals(buffer, i, i + a.length, a, 0, a.length)) foundA = true;
                            if (i + b.length <= length && Arrays.equals(buffer, i, i + b.length, b, 0, b.length)) foundB = true;
                        }
                        retained = Math.min(overlap, length);
                        System.arraycopy(buffer, length - retained, buffer, 0, retained);
                    }
                }
                System.out.println("scanned native file=" + path + " bytes=" + Files.size(path));
            }
        }
        require(files > 0 && foundB && foundA == source,
            "Native marker control failed: files=" + files + " A=" + foundA + " B=" + foundB);
    }

    public static void main(String[] args) throws Exception {
        String mode = args[0];
        if (Files.exists(MANIFEST)) {
            try (InputStream in = Files.newInputStream(MANIFEST)) { state.load(in); }
        }
        if (mode.startsWith("scan-")) {
            scan(Path.of(mode.equals("scan-source") ? "/old" : "/replacement"), mode.equals("scan-source"));
            return;
        }
        ClientConfiguration config = new ClientConfiguration();
        config.setMetadataServiceUri("metadata-store:oxia://pulsar-oxia:6648/bookkeeper");
        config.setAddEntryTimeout(10).setReadEntryTimeout(10);
        config.setProperty("metadataServiceTimeoutMs", 10000);
        try (BookKeeper client = new BookKeeper(config); BookKeeperAdmin admin = new BookKeeperAdmin(client)) {
            switch (mode) {
                case "initial":
                    require(identities(admin.getAvailableBookies()).equals(Set.of(OLD)), "Source not sole writable bookie");
                    require(admin.getReadOnlyBookies().isEmpty(), "Unexpected initial readonly registration");
                    break;
                case "preflight":
                    require(state.isEmpty(), "Preflight requires an empty synthetic manifest");
                    require(!admin.listLedgers().iterator().hasNext(), "Preflight requires an empty ledger inventory");
                    state.setProperty("bMarker", "client-preflight-" + UUID.randomUUID());
                    create(client, "closed", true);
                    verify(client, admin, OLD);
                    client.deleteLedger(Long.parseLong(state.getProperty("closed")));
                    require(!admin.listLedgers().iterator().hasNext(), "Preflight deletion left surviving ledgers");
                    state.remove("closed");
                    state.remove("closedHash");
                    state.remove("bMarker");
                    save();
                    break;
                case "seed":
                    state.setProperty("aMarker", "account-a-" + UUID.randomUUID());
                    state.setProperty("bMarker", "account-b-" + UUID.randomUUID());
                    create(client, "a", true);
                    create(client, "closed", true);
                    create(client, "open", false);
                    break;
                case "delete":
                    client.deleteLedger(Long.parseLong(state.getProperty("a")));
                    verify(client, admin, OLD);
                    break;
                case "registered":
                    require(identities(admin.getAvailableBookies()).equals(Set.of(TARGET)), "Replacement not sole writable bookie");
                    require(identities(admin.getReadOnlyBookies()).equals(Set.of(OLD)), "Source not registered readonly");
                    verify(client, admin, OLD);
                    break;
                case "new":
                    create(client, "new", true);
                    verify(client, admin, TARGET);
                    break;
                case "verify":
                    verify(client, admin, TARGET);
                    break;
                default: throw new IllegalArgumentException(mode);
            }
        }
        System.out.println("PASS " + mode);
    }
}
