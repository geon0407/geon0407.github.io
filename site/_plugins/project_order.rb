# Orders projects newest first, for the home "Latest Works" section, the Projects page
# and the "Next project" link:
#   1. ongoing projects (newest start month first)
#   2. then by end month, falling back to start month, then to the date field.
# Jekyll would otherwise list projects by the date field, oldest first.
module StudioProjectOrder
  class Generator < Jekyll::Generator
    safe true
    priority :low

    def generate(site)
      projects = site.collections["projects"]
      return unless projects

      projects.docs.sort_by! { |doc| sort_key(doc) }.reverse!
    end

    private

    def sort_key(doc)
      data = doc.data
      date = data["date"].respond_to?(:strftime) ? data["date"].strftime("%Y-%m-%d") : data["date"].to_s
      ongoing = data["ongoing"] == true
      month = if ongoing
                month(data["period_start"]) || date[0, 7]
              else
                month(data["period_end"]) || month(data["period_start"]) || date[0, 7]
              end
      [ongoing ? 1 : 0, month.to_s, date, doc.relative_path]
    end

    def month(value)
      value.to_s[/\A\d{4}-\d{2}/]
    end
  end
end
