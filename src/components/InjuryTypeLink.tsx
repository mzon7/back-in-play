import { Link } from "react-router-dom";

interface InjuryTypeLinkProps {
  injury_type: string;
  injury_type_slug: string;
  className?: string;
}

export function InjuryTypeLink({
  injury_type,
  injury_type_slug,
  className,
}: InjuryTypeLinkProps) {
  return (
    <Link
      to={`/injury-type/${injury_type_slug}`}
      className={
        className ??
        "text-xs text-[#3DFF8F] hover:text-[#3DFF8F]/70 transition-colors font-medium"
      }
    >
      {injury_type}
    </Link>
  );
}
