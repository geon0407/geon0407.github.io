# Project ordering.
#   finished projects: latest end month first (end month falls back to start month, then date)
#   ongoing projects:  latest start month first — the longest-running comes last
#
# Everywhere (Projects page, "Next project" link, home): ongoing first, then finished.
# Home "Latest Works" (site.data.home_projects) shows at most HOME_LIMIT cards: every
# ongoing project, with the remaining slots going to the most recently finished.
module StudioProjectOrder
  HOME_LIMIT = 8

  class Generator < Jekyll::Generator
    safe true
    priority :low

    def generate(site)
      projects = site.collections["projects"]
      return unless projects

      ongoing, finished = projects.docs.partition { |doc| ongoing?(doc) }
      ongoing = newest_first(ongoing) { |doc| start_month(doc) }
      finished = newest_first(finished) { |doc| end_month(doc) }
      projects.docs.replace(ongoing + finished)

      home_ongoing = ongoing.first(HOME_LIMIT)
      site.data["home_projects"] = home_ongoing + finished.first(HOME_LIMIT - home_ongoing.size)
    end

    private

    def newest_first(docs)
      docs.sort_by { |doc| [yield(doc), date(doc), doc.relative_path] }.reverse
    end

    def ongoing?(doc)
      doc.data["ongoing"] == true
    end

    def start_month(doc)
      month(doc.data["period_start"]) || date(doc)[0, 7]
    end

    def end_month(doc)
      month(doc.data["period_end"]) || month(doc.data["period_start"]) || date(doc)[0, 7]
    end

    def date(doc)
      value = doc.data["date"]
      value.respond_to?(:strftime) ? value.strftime("%Y-%m-%d") : value.to_s
    end

    def month(value)
      value.to_s[/\A\d{4}-\d{2}/]
    end
  end
end
