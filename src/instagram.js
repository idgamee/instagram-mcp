const BASE_URL = "https://graph.instagram.com/v22.0";

export class InstagramClient {
  constructor({ accessToken, igUserId }) {
    this.accessToken = accessToken;
    this.igUserId = igUserId;
  }

  async apiGet(path, params = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("access_token", this.accessToken);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const res = await fetch(url.toString());
    const data = await res.json();

    if (data.error) {
      throw new Error(
        `Instagram API [${data.error.code}] ${data.error.type}: ${data.error.message}`
      );
    }
    return data;
  }

  async getAccountInsights(period = "days_28") {
    const [profileResult, insightsResult, followerResult] = await Promise.allSettled([
      this.apiGet(`/${this.igUserId}`, {
        fields:
          "username,biography,website,followers_count,follows_count,media_count,profile_picture_url",
      }),
      this.apiGet(`/${this.igUserId}/insights`, {
        metric: "reach,impressions,profile_views",
        period,
      }),
      this.apiGet(`/${this.igUserId}/insights`, {
        metric: "follower_count",
        period: "day",
      }),
    ]);

    const result = {
      period,
      profile:
        profileResult.status === "fulfilled" ? profileResult.value : { error: profileResult.reason?.message },
      insights: {},
    };

    if (insightsResult.status === "fulfilled") {
      for (const item of insightsResult.value.data ?? []) {
        result.insights[item.name] = {
          title: item.title,
          description: item.description,
          values: item.values,
        };
      }
    }

    if (followerResult.status === "fulfilled") {
      for (const item of followerResult.value.data ?? []) {
        result.insights[item.name] = {
          title: item.title,
          values: item.values,
        };
      }
    }

    return result;
  }

  async getPostInsights(mediaId) {
    const media = await this.apiGet(`/${mediaId}`, {
      fields:
        "id,caption,media_type,timestamp,permalink,like_count,comments_count,media_url,thumbnail_url",
    });

    const metricsByType = {
      IMAGE: "reach,impressions,saved,likes,comments,shares",
      VIDEO: "reach,impressions,saved,likes,comments,shares,plays",
      CAROUSEL_ALBUM: "reach,impressions,saved,likes,comments,shares",
      REELS: "reach,plays,likes,comments,shares,saved,total_interactions",
    };

    const metricStr =
      metricsByType[media.media_type] ?? "reach,impressions,saved,likes,comments";

    let insights;
    try {
      const data = await this.apiGet(`/${mediaId}/insights`, { metric: metricStr });
      insights = Object.fromEntries(
        (data.data ?? []).map((m) => [
          m.name,
          { value: m.values?.[0]?.value ?? m.value, title: m.title },
        ])
      );
    } catch (err) {
      insights = { error: err.message };
    }

    return { media, insights };
  }

  async getAudienceData() {
    const metrics = [
      "audience_gender_age",
      "audience_city",
      "audience_country",
      "audience_locale",
    ];

    const result = {};
    for (const metric of metrics) {
      try {
        const data = await this.apiGet(`/${this.igUserId}/insights`, {
          metric,
          period: "lifetime",
        });
        const item = data.data?.[0];
        result[metric] = item?.values?.[0]?.value ?? item?.value ?? null;
      } catch (err) {
        result[metric] = { error: err.message };
      }
    }

    return result;
  }

  async listRecentPosts(limit = 10) {
    const data = await this.apiGet(`/${this.igUserId}/media`, {
      fields:
        "id,caption,media_type,timestamp,permalink,like_count,comments_count,media_url,thumbnail_url",
      limit,
    });

    const posts = data.data ?? [];

    // Fetch basic insights for each post in parallel
    const enriched = await Promise.all(
      posts.map(async (post) => {
        try {
          const insightsData = await this.apiGet(`/${post.id}/insights`, {
            metric: "reach,impressions,saved",
          });
          return {
            ...post,
            insights: Object.fromEntries(
              (insightsData.data ?? []).map((m) => [
                m.name,
                m.values?.[0]?.value ?? m.value,
              ])
            ),
          };
        } catch {
          return post;
        }
      })
    );

    return enriched;
  }
}
