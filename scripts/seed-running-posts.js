const { randomUUID } = require("crypto");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { Pool } = require("pg");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const bucketName = "post-images";
const authorNames = ["alice_green", "bob_builder", "charlie_brown"];
const args = process.argv.slice(2);
const hasArg = (name) => args.includes(name);
const argValue = (name) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

const posts = [
  {
    author: "alice_green",
    title: "Sunrise miles with the crew",
    content:
      "We caught the quiet roads just as the sky turned blue. Easy pace, good company, and nobody checking the watch.",
    imageId: "photo-1552674605-db6ffd4facb5",
  },
  {
    author: "bob_builder",
    title: "One step closer",
    content:
      "A few steady stair repeats before work. Kept the effort smooth and finished with enough left for the walk home.",
    imageId: "photo-1476480862126-209bfaa8edc8",
  },
  {
    author: "charlie_brown",
    title: "Easy miles, clear head",
    content:
      "Thirty relaxed minutes and no pace target today. Sometimes the best training plan is to keep it simple.",
    imageId: "photo-1538805060514-97d9cc17730c",
  },
  {
    author: "alice_green",
    title: "Track night: quick feet",
    content:
      "Short intervals, full recovery, and a little friendly competition on the last rep. That one felt good.",
    imageId: "photo-1461896836934-ffe607ba8211",
  },
  {
    author: "bob_builder",
    title: "Strength for the long run",
    content:
      "A controlled strength session to support the miles. Nothing heroic, just consistent work between run days.",
    imageId: "photo-1517836357463-d25dfeac3438",
  },
  {
    author: "charlie_brown",
    title: "Intervals are better together",
    content:
      "We took turns leading each repeat and regrouped between efforts. Everyone finished strong, whatever their pace.",
    imageId: "photo-1502904550040-7534597429ae",
  },
  {
    author: "alice_green",
    title: "A little work off the road",
    content:
      "Mobility and strength today, with an easy recovery jog pencilled in for tomorrow. Training is the whole week, not one workout.",
    imageId: "photo-1546483875-ad9014c88eba",
  },
  {
    author: "bob_builder",
    title: "Race-day ritual",
    content:
      "Laces double-knotted, kit laid out, and a calm start planned. Looking forward to enjoying the miles tomorrow.",
    imageId: "photo-1483721310020-03333e577078",
  },
  {
    author: "charlie_brown",
    title: "Recovery deserves a slot",
    content:
      "A few minutes of stretching after an easy run made all the difference. Future me says thanks.",
    imageId: "photo-1518611012118-696072aa579a",
  },
  {
    author: "alice_green",
    title: "Reset, lace up, go",
    content:
      "Fresh shoes, familiar route, no big agenda. Just showing up again and stacking another good day.",
    imageId: "photo-1495555961986-6d4c1ecb7be3",
  },
].map((post, index, allPosts) => ({
  ...post,
  visibility: "Public",
  createdAt: new Date(
    Date.now() - (allPosts.length - index - 1) * 6 * 60 * 60 * 1000,
  ),
  sourceUrl: `https://images.unsplash.com/${post.imageId}?fit=crop&w=900&h=650&q=82&fm=jpg`,
}));

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function getProjectRef(supabaseUrl) {
  const hostname = new URL(supabaseUrl).hostname;
  if (!hostname.endsWith(".supabase.co")) {
    throw new Error("SUPABASE_URL is not a standard Supabase project URL");
  }
  return hostname.split(".")[0];
}

async function inspectTarget(pool) {
  const client = await pool.connect();
  try {
    const targetResult = await client.query(
      "SELECT current_database() AS database_name, current_schema() AS schema_name",
    );
    const target = targetResult.rows[0];
    const columnsResult = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'posts_social'`,
    );
    const columns = new Set(columnsResult.rows.map((row) => row.column_name));
    for (const column of [
      "post_id",
      "user_id",
      "title",
      "content",
      "visibility",
      "created_at",
      "img_url",
    ]) {
      if (!columns.has(column)) {
        throw new Error(`posts_social is missing required column: ${column}`);
      }
    }

    const authorResult = await client.query(
      "SELECT user_id, username FROM users_social WHERE username = ANY($1::varchar[])",
      [authorNames],
    );
    const authors = new Map(
      authorResult.rows.map((author) => [author.username, author.user_id]),
    );
    const missingAuthors = authorNames.filter((name) => !authors.has(name));
    if (missingAuthors.length) {
      throw new Error(
        `Missing existing dev authors: ${missingAuthors.join(", ")}`,
      );
    }

    const postCountResult = await client.query(
      "SELECT count(*)::int AS count FROM posts_social",
    );
    const referencesResult = await client.query(
      `SELECT tc.constraint_name,
              tc.table_schema AS referencing_schema,
              tc.table_name AS referencing_table,
              array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS referencing_columns
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.constraint_schema = kcu.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_schema = current_schema()
          AND ccu.table_name = 'posts_social'
        GROUP BY tc.constraint_name, tc.table_schema, tc.table_name
        ORDER BY tc.table_name`,
    );
    const references = referencesResult.rows;
    const referenceCounts = [];

    for (const reference of references) {
      const table = `${quoteIdentifier(reference.referencing_schema)}.${quoteIdentifier(reference.referencing_table)}`;
      const hasReference = reference.referencing_columns
        .map((column) => `${quoteIdentifier(column)} IS NOT NULL`)
        .join(" AND ");
      const result = await client.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE ${hasReference}`,
      );
      referenceCounts.push({
        table: reference.referencing_table,
        columns: reference.referencing_columns,
        count: result.rows[0].count,
      });
    }

    return {
      target,
      authors,
      currentPosts: postCountResult.rows[0].count,
      references,
      referenceCounts,
    };
  } finally {
    client.release();
  }
}

async function uploadImages(supabase, runId) {
  const uploadedPaths = [];
  const seededPosts = [];

  try {
    for (let index = 0; index < posts.length; index += 1) {
      const post = posts[index];
      const imageResponse = await fetch(post.sourceUrl);
      if (!imageResponse.ok) {
        throw new Error(
          `Image source failed (${imageResponse.status}) for ${post.imageId}`,
        );
      }

      const sourceType = imageResponse.headers.get("content-type") || "";
      if (!sourceType.startsWith("image/")) {
        throw new Error(
          `Image source returned ${sourceType || "no content type"}`,
        );
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const objectPath = `seed/running-friends/${runId}/${String(index + 1).padStart(2, "0")}-${post.imageId}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from(bucketName)
        .upload(objectPath, imageBuffer, {
          contentType: "image/jpeg",
          upsert: false,
        });
      if (uploadError) throw uploadError;
      uploadedPaths.push(objectPath);

      const imageUrl = supabase.storage
        .from(bucketName)
        .getPublicUrl(objectPath).data.publicUrl;
      const verification = await fetch(imageUrl, { method: "HEAD" });
      if (
        !verification.ok ||
        !verification.headers.get("content-type")?.startsWith("image/")
      ) {
        throw new Error(`Uploaded image failed verification: ${objectPath}`);
      }
      seededPosts.push({ ...post, imageUrl });
    }

    return { seededPosts, uploadedPaths };
  } catch (error) {
    if (uploadedPaths.length) {
      const { error: cleanupError } = await supabase.storage
        .from(bucketName)
        .remove(uploadedPaths);
      if (cleanupError) {
        console.error(
          `Cleanup failed for ${uploadedPaths.length} images from this seed run.`,
        );
      }
    }
    throw error;
  }
}

async function replacePosts(pool, seedPosts, authors, references) {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const referenceTables = [
      ...new Map(
        references.map((reference) => [
          `${reference.referencing_schema}.${reference.referencing_table}`,
          reference,
        ]),
      ).values(),
    ].sort((left, right) =>
      `${left.referencing_schema}.${left.referencing_table}`.localeCompare(
        `${right.referencing_schema}.${right.referencing_table}`,
      ),
    );

    for (const reference of referenceTables) {
      await client.query(
        `LOCK TABLE ${quoteIdentifier(reference.referencing_schema)}.${quoteIdentifier(reference.referencing_table)} IN SHARE MODE`,
      );
    }
    await client.query(
      `LOCK TABLE ${quoteIdentifier("public")}."posts_social" IN ACCESS EXCLUSIVE MODE`,
    );

    const referenceCounts = [];
    for (const reference of references) {
      const table = `${quoteIdentifier(reference.referencing_schema)}.${quoteIdentifier(reference.referencing_table)}`;
      const hasReference = reference.referencing_columns
        .map((column) => `${quoteIdentifier(column)} IS NOT NULL`)
        .join(" AND ");
      const result = await client.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE ${hasReference}`,
      );
      referenceCounts.push(result.rows[0].count);
    }
    if (referenceCounts.some((count) => count > 0)) {
      throw new Error(
        "Posts became linked to other records; refusing to replace them",
      );
    }

    await client.query("DELETE FROM public.posts_social");
    for (const post of seedPosts) {
      await client.query(
        `INSERT INTO public.posts_social
          (title, content, visibility, user_id, img_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          post.title,
          post.content,
          post.visibility,
          authors.get(post.author),
          post.imageUrl,
          post.createdAt,
        ],
      );
    }

    const verifyResult = await client.query(
      `SELECT count(*)::int AS post_count,
              count(img_url)::int AS image_count,
              count(DISTINCT img_url)::int AS unique_image_count
         FROM public.posts_social`,
    );
    const counts = verifyResult.rows[0];
    if (
      counts.post_count !== posts.length ||
      counts.image_count !== posts.length ||
      counts.unique_image_count !== posts.length
    ) {
      throw new Error(
        "Post/image verification failed; transaction rolled back",
      );
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return counts;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const apply = hasArg("--apply");
  const confirmed = hasArg("--confirm-dev-reset");
  if (apply !== confirmed) {
    throw new Error("Use both --apply and --confirm-dev-reset to replace rows");
  }
  if (!process.env.DATABASE_URL || !process.env.SUPABASE_URL) {
    throw new Error("DATABASE_URL and SUPABASE_URL are required");
  }
  if (apply && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to upload images");
  }

  const databaseUrl = new URL(process.env.DATABASE_URL);
  const projectRef = getProjectRef(process.env.SUPABASE_URL);
  const expectedHost = argValue("--expected-db-host");
  const expectedProject = argValue("--expected-supabase-ref");
  if (apply) {
    if (!expectedHost || !expectedProject) {
      throw new Error(
        "Applying also requires --expected-db-host=<dev-host> and --expected-supabase-ref=<dev-project-ref>",
      );
    }
    if (databaseUrl.hostname !== expectedHost) {
      throw new Error("DATABASE_URL host did not match --expected-db-host");
    }
    if (projectRef !== expectedProject) {
      throw new Error("Supabase project did not match --expected-supabase-ref");
    }
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  let uploadedPaths = [];
  let committed = false;

  try {
    const preflight = await inspectTarget(pool);
    const linkedRows = preflight.referenceCounts.reduce(
      (total, reference) => total + reference.count,
      0,
    );
    console.log(
      JSON.stringify(
        {
          mode: apply ? "APPLY" : "DRY RUN",
          database: preflight.target.database_name,
          schema: preflight.target.schema_name,
          databaseHost: databaseUrl.hostname,
          supabaseProjectRef: projectRef,
          currentPosts: preflight.currentPosts,
          postsToInsert: posts.length,
          authors: authorNames,
          postReferences: preflight.referenceCounts,
        },
        null,
        2,
      ),
    );

    if (linkedRows > 0) {
      throw new Error(
        "Posts are referenced by other records; refusing replacement",
      );
    }
    if (!apply) {
      console.log("Dry run only: no images uploaded and no rows changed.");
      return;
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const runId = randomUUID();
    const uploadResult = await uploadImages(supabase, runId);
    uploadedPaths = uploadResult.uploadedPaths;
    const counts = await replacePosts(
      pool,
      uploadResult.seededPosts,
      preflight.authors,
      preflight.references,
    );
    committed = true;
    console.log(
      JSON.stringify(
        {
          result: "Seed complete",
          insertedPosts: counts.post_count,
          verifiedImages: counts.image_count,
          uniqueImages: counts.unique_image_count,
          storagePrefix: `seed/running-friends/${runId}/`,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (!committed && uploadedPaths.length) {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { error: cleanupError } = await supabase.storage
        .from(bucketName)
        .remove(uploadedPaths);
      if (cleanupError) {
        console.error(
          `Cleanup failed for ${uploadedPaths.length} images from this seed run.`,
        );
      }
    }
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Running Friends seed stopped: ${error.message}`);
  process.exitCode = 1;
});
