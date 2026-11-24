# About page history: every entry in one list, newest first by the first date in its period
# ("2024.03–2025.09" -> 2024.03, "2015.07 · 2018.07" -> 2015.07, "2003" -> 2003).
# Entries with the same date keep their Blog Studio order. Exposed as site.data.history_sorted.
module StudioHistoryOrder
  class Generator < Jekyll::Generator
    safe true
    priority :low

    def generate(site)
      timeline = site.data.dig("studio", "profile", "timeline") || []
      indexed = timeline.each_with_index.map { |entry, index| [entry, index] }
      sorted = indexed.sort_by { |entry, index| [sort_key(entry["period"]), -index] }.reverse
      site.data["history_sorted"] = sorted.map(&:first)
    end

    private

    def sort_key(period)
      match = period.to_s.match(/(\d{4})(?:\s*[.\-\/]\s*(\d{1,2}))?/)
      return "0000-00" unless match

      format("%s-%02d", match[1], match[2].to_i)
    end
  end
end
